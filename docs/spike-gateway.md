# Spike: a unified gateway with Mesh v1 composition and the Hive Gateway runtime

Can Symphony compose the upstreams added through its UI into one supergraph at runtime, and serve it in-process?
Yes. All six questions have a passing test in `tests/gateway/`, against in-process fixtures: a GraphQL "directory"
(`tests/fixtures/directory-service.ts`), a REST "billing" service described by OpenAPI 3
(`tests/fixtures/billing-service.ts`), and an in-memory "presence" schema (`tests/fixtures/presence-schema.ts`).
The code is in `server/gateway/`. There is no `mesh.config.ts` and no CLI step.

## Answers

| #   | Question                                          | Result                   | Test                         |
| --- | ------------------------------------------------- | ------------------------ | ---------------------------- |
| 1   | Merge `Team` by key across non-Federation sources | Works                    | `merge.test.ts`              |
| 2   | `additionalTypeDefs` + `@resolveTo`               | Works, with a workaround | `additional-fields.test.ts`  |
| 3   | Recompose and hot-swap at runtime                 | Works                    | `hot-swap.test.ts`           |
| 4   | In-process subgraph, no HTTP                      | Works                    | `in-process.test.ts`         |
| 5   | Per-source headers, server-side                   | Works                    | `headers.test.ts`            |
| 6   | Structured composition errors                     | Works                    | `composition-errors.test.ts` |

### 1. Merging on a key

Composition uses `composeSubgraphs(subgraphs)` from `@graphql-mesh/fusion-composition`. Each source gets two
transforms:

- `createRenameTransform({ renames })` renames `DirectoryTeam` and `BillingTeam` to `Team`, and the clashing
  `members` fields to `directoryMembers` and `billingMembers`. The catch is that a field rename has to name the
  source's own type on both ends: `{ from: { type: 'DirectoryTeam', field: 'members' }, to: { type: 'DirectoryTeam', field: 'directoryMembers' } }`.
  Mesh compares the field rename against the type name from before the type rename, so `to: { type: 'Team' }`
  silently does nothing.
- `createFederationTransform({ Team: { shareable: true, key: { fields: 'slug', resolveReference: { fieldName: 'team', keyField: 'slug' } } } })`
  declares the key. `resolveReference` names the root field that looks the entity up. It becomes a Mesh
  `@merge(subgraph:, keyField:, argsExpr: "slug: $key.slug")` on that field, plus `@key(fields: "slug")` on the type.
  `shareable: true` is required: both sources resolve `slug` and `name`, and the Federation composer refuses
  non-shareable fields that more than one subgraph resolves (`INVALID_FIELD_SHARING`).

This is how keys and merge lookups are declared for plain GraphQL and OpenAPI subgraphs in Mesh v1. The other
option is naming conventions: a root field named `<type>`, `<type>_by_<key>` or `get_<types>_by_<keys>`, with an
argument matching a field of the type, is annotated automatically unless `ignoreSemanticConventions` is set. That
is too implicit for user-added sources, so the module always declares keys explicitly (`mergeKeys` on a source).
There is no `@merge` in `additionalTypeDefs` and no separate type-merging transform in v1. The v0 `typeMerging`
transform is gone.

OpenAPI sources load with `loadOpenAPISubgraph(name, { source: specUrl, endpoint })(ctx).schema$` from
`@omnigraph/openapi`. `ctx` is `{ fetch, cwd, logger }`, where `logger` must be a Mesh logger with `child()`, and
`console` does not work. Operation ids become root fields (`billingTeam`, `teamInvoices`), and component schemas
become types (`BillingTeam`).

The gateway plans `{ team(slug: "a") { slug name plan directoryMembers billingMembers } }` as one POST to the
directory, then `GET /teams/a` to billing. The query also works the other way in, starting from `billingTeam`.

### 2. `additionalTypeDefs` with `@resolveTo`

`Team.invoices` resolves from billing's second route:

```graphql
extend type Team {
  invoices: [Invoice]
    @resolveTo(
      sourceName: "billing"
      sourceTypeName: "Query"
      sourceFieldName: "teamInvoices"
      requiredSelectionSet: "{ slug }"
      sourceArgs: { slug: "{root.slug}" }
    )
}
```

The workaround: `composeSubgraphs` has no `additionalTypeDefs` option. Only the compose CLI's
`getComposedSchemaFromConfig` has one, and on any failure that function calls `process.exit(1)`, which rules it out
inside a server. `composeSupergraph` does what the CLI does instead: it adds each extension's fields to the
composed type, marks them `@additionalField`, and the runtime wires their `@resolveTo`. It is about 40 lines, done
on the graphql-js AST. The runtime's own `additionalTypeDefs` option would also work, but it is fixed for the life
of the runtime, so it would not change on a swap.

### 3. Recompose and hot swap

`createGatewayRuntime({ supergraph: () => current.sdl, ... })` takes the supergraph as a function. A swap sets
`current`, calls `runtime.invalidateUnifiedGraph()`, and awaits `runtime.getSchema()`. The runtime object stays the
same, so the Express mount and the handler identity survive. Polling is not needed, and neither is recreating the
runtime.

Cost, on this machine with the fixtures: composing 1 source took about 40 ms, and 2 sources (one of them OpenAPI)
about 65 ms. A swap took 5 to 20 ms, and the first query after it took about 4 ms.

By default the runtime disposes the previous generation immediately, which aborts in-flight operations with
`SCHEMA_RELOAD`. Queries are retried; mutations are not. The gateway sets
`gracefulSchemaReload: { drainTimeout: GATEWAY_DEFAULTS.swapDrainMs }`, so in-flight operations drain on the old
generation. A failed `recompose` throws before the swap, so the last good supergraph keeps serving (tested).

### 4. In-process subgraph without HTTP

This works through a custom transport. A `schema` source is marked with a schema-level
`@transport(kind: "in-process")` directive in its `extensions` before composition, and the composer carries it into
the supergraph. The runtime's `transports` option is a getter from kind to transport. For `in-process`, it returns
`{ getSubgraphExecutor: ({ subgraphName }) => createDefaultExecutor(schema) }`, where `createDefaultExecutor` comes
from `@graphql-mesh/transport-common`. The presence schema adds `Team.presence`, merged by `slug` like any other
source, and owns `setPresence`. The mutation runs in the schema's resolver with no request to any network source,
and the gateway still fills `name` from the directory on the mutation's result. A `fetch` override was not needed.

Passing `transports` replaces the runtime's default loader (`import('@graphql-mesh/transport-<kind>')`). The getter
therefore also maps `http` to `@graphql-mesh/transport-http` and `rest` to `@graphql-mesh/transport-rest`, and both
are direct dependencies.

### 5. Per-source headers

A gateway plugin with an `onFetch` hook does it. Every subgraph fetch, GraphQL and REST, carries
`executionRequest.subgraphName`, and the plugin merges that source's `headers` with `setOptions`. The test shows
each fixture receiving only its own secret. Caller headers such as `cookie` are not forwarded unless a plugin adds
them (`usePropagateHeaders` exists for that). The plugin reads the current sources on every fetch, so a header
change takes effect on the next swap with no new runtime. `transportEntries: { <name>: { headers } }` is an
alternative for HTTP sources, but it is fixed at creation.

### 6. Composition errors

`composeSubgraphs` returns `errors: GraphQLError[]` and does not throw. Each error has a Federation code in
`extensions.code`, for example `FIELD_TYPE_MISMATCH` with the message
`Type of field "Team.members" is incompatible across subgraphs: it has type "Int!" in subgraph "billing" but type
"[DirectoryMember!]!" in subgraph "directory"`, or `INVALID_FIELD_SHARING`. Transforms throw instead
(`TransformValidationError`, for example a merge key on a missing type), and so do source loaders.
`composeSupergraph` turns all three into one `SupergraphCompositionError` with
`issues: { message, code, source? }[]`. Load and transform failures come back as `SOURCE_LOAD_FAILED` and
`TRANSFORM_FAILED` and name the source: the module dry-runs each source's transforms to get that attribution.
Federation errors name the subgraphs only in their message text. A bad OpenAPI URL that answers 404 with JSON does
not fail to load: it fails later, as a transform error, because the loader accepts any JSON.

## Dependencies

Added, all pinned exactly: `@graphql-hive/gateway-runtime@3.0.0`, `@graphql-mesh/fusion-composition@0.11.4`,
`@omnigraph/openapi@0.112.7`, `@graphql-mesh/transport-http@2.0.0`, `@graphql-mesh/transport-rest@0.12.5` and
`@graphql-mesh/transport-common@2.0.0`. The runtime package was used instead of `@graphql-hive/gateway`, which is the
CLI and pulls in more.

The weight is 233 new entries in `package-lock.json` (94 top-level installs) and about 84 MB on disk. No existing
package changed version. The runtime brings its own `graphql-yoga@6` next to Symphony's yoga 5, nested under
`@graphql-hive/gateway-runtime` and `@graphql-mesh/fusion-runtime`. graphql 16 is fine: the peer range is
`^16.9 || ^17`. `@apollo/protobufjs` arrives with an install script, which npm's `allowScripts` blocks. Nothing
here needs it.

## What contradicts the plan

- **The compose CLI cannot run inside a server.** `getComposedSchemaFromConfig` calls `process.exit(1)` on a load or
  composition failure, so `fusion-composition` is used directly and `additionalTypeDefs` is re-implemented (see 2).
- **Version skew.** `@graphql-hive/gateway-runtime@3.0.0` was released the day of the spike. The REST transport
  (`transport-rest@0.12.5`, the latest) is still built on `transport-common@1`. It reads a Mesh `logger` that
  Gateway 3 no longer passes, and its types name a second copy of `@graphql-hive/logger`. `server/gateway/transports.ts`
  adapts it: it passes a logger and uses one documented cast. Gateway 2.14.x would avoid the skew but brings yoga 5.
  Re-check this before building on it.
- **Merged types must be shareable.** Composition is Federation 2 semantics. Every type that is merged is marked
  `@shareable` in every source, which also hides genuine conflicts on non-key fields (two sources both claiming
  `name` with different meanings). Renames are the only guard against that.
- **Shared fields need compatible types.** Federation composition compares the types of a field resolved by several
  sources, which is how the `members` clash fails. The fixtures use `String!` for `slug` on both sides. `ID!` against
  `String!` was not tested, but it is expected to fail the same way. Real upstreams may need a type-coercing
  transform.
