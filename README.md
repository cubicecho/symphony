# Symphony

One UI for the cubicecho apps: it talks to each headless server over GraphQL, and to agents over MCP.
It builds runtime web UIs over GraphQL APIs that have none of their own.

- **Upstreams.** Register a GraphQL API: its URL, plus headers kept on the server. Symphony introspects it and caches the schema.
- **Modules.** A module is one React (TSX) file over one or more upstreams, listed in order. Plain `gql` documents go to the first (the default), and `gql.from('<name>')` documents to another. Agents write them over MCP, and people write them in the web editor.
- **Checks.** Symphony checks every module (allowed imports, a default export, and GraphQL documents each validated against its own upstream's cached schema), then compiles it with esbuild. Errors come back with line and column, so an agent can fix them and submit again.
- **The unified upstream.** A built-in upstream named `unified` serves every upstream and concept composed into one API (the schema `/unified/graphql` serves). Modules can be written against it like any other; it can't be edited, refreshed or deleted, and its modules are checked again whenever a recompose changes its schema.
- **Pages.** People place modules on pages. Modules render live data through Symphony's proxy, which checks each document before it forwards it. The browser never sees an upstream's address or its credentials.

The rules a module follows, and the `symphony` runtime it imports, are in
[docs/module-contract.md](docs/module-contract.md). Agents are served the same file.

## Quick start

```sh
npm install
cp .env.example .env        # set SYMPHONY_MCP_KEY (openssl rand -hex 32)
npm run dev                 # web on http://localhost:3000, API on :8787
npm run fixture:upstream    # optional: a sample shop API on :4100 to wrap
```

In the web app, go to **Upstreams → Add upstream** and enter `http://localhost:4100/graphql`.

## Connecting an agent

Symphony listens on the network (`HOST=0.0.0.0`), so Claude Code on another machine can reach it:

```sh
claude mcp add --transport http symphony http://<symphony-host>:3000/mcp --header "x-api-key: <SYMPHONY_MCP_KEY>"
```

Then ask for a module, for example "a module showing recent orders as a table".

**The agent's tools:** `list_upstreams`, `get_schema`, `search_schema`, `run_query`, `list_components`, `get_component_docs`, `get_module_contract`, `check_module`, `submit_module`, `list_modules`, `get_module`.

**What it does with them:**

1. Reads the schema and the cubeui component docs.
2. Tries its queries with `run_query`.
3. Submits the module, fixing it until it compiles.

You then place the module on a page.

**Concept proposals.** `propose_concepts` drafts concepts from the upstreams' cached schemas: object types in two
or more upstreams whose names match once a prefix or suffix is removed, each with `id: ID!` and a Query lookup by
id. Fields every member has with one scalar type are shared, the rest owned; `createX` / `updateX` / `deleteX`
become member documents when their arguments map by name. Each draft comes with reasons, a confidence per
decision, and the concept validator's problems. `submit_concept` stores a definition as a pending proposal (resubmit
with the returned id until it passes), and a person accepts or rejects it over the admin API
(`acceptConceptProposal`, `rejectConceptProposal`); accepting saves it as a concept.

## Network discovery

Symphony describes its MCP endpoint so other tools, such as
[mcp-router](https://github.com/cubicecho/mcp-router), can find it without being given the URL:

- `GET /.well-known/ai-catalog.json` is an [AI Catalog](https://github.com/Agent-Card/ai-catalog) listing `/mcp`.
- `GET /mcp/server-card` is its [MCP Server Card](https://modelcontextprotocol.io/seps/2127-mcp-server-cards):
  `io.github.cubicecho.symphony.<host>/symphony`, with the URL the request came in on.

Both are public, with no key needed. The card says `/mcp` needs an `Authorization` header (the key as a bearer
token), but never carries the key. Both come from
[`@cubicecho/mcp-discovery`](https://github.com/cubicecho/mcp-discovery).

**Advertise on the local network** with `LAN_ADVERTISE=true` (off by default): Symphony then also announces itself
over mDNS as an `_mcp._tcp` service once it is listening, so it can be found without knowing its address, and says
goodbye on shutdown. mDNS needs multicast, which Docker's default bridge network drops: in a container, use
`network_mode: host` (commented in `docker-compose.yml`) for the announcement to reach the LAN.

## Trust model (Phase 1)

- **Single operator, self-hosted.** The web UI, the admin API at `/graphql` and the unified API at `/unified/graphql` have no sign-in. Only `/mcp` takes a key. Run Symphony on a network you trust.
- **Modules run in the page itself.** There is no iframe sandbox. The compiler only allows the imports listed in the contract, but module code can do anything page script can.
- **Header secrets.** Header values may say `${env:SYMPHONY_…}`. The reference is stored, and the value is filled in only when a request goes out.

## Layout

```
server/   Express + graphql-yoga + drizzle (PGlite in DATA_DIR, or Postgres via DATABASE_URL)
  upstreams/  introspection, schema cache, proxy, header secrets
  modules/    compile pipeline (babel parse → import allowlist → gql validation → esbuild) and storage
  pages/      pages and placed items
  concepts/   concepts as data: validation, the generated concept subgraph and its engine
  gateway/    the unified API: concept and wiring storage, field conflicts, composition, the hot-swapped gateway at
              /unified/graphql (docs/spike-gateway.md, "Concepts")
  mcp/        the agents' door (MCP SDK, stateless Streamable HTTP)
  discovery/  the Server Card and AI Catalog entry for /mcp (@cubicecho/mcp-discovery)
  catalog/    cubeui component catalogue and docs (synced by `npm run catalog:sync`)
web/      Vite + React + TanStack Router/Query + cubeui; web/src/modules is the module runtime and loader
docs/     module-contract.md
tests/    Vitest; tests/fixtures/upstream.ts is the sample API
```

## Scripts

`npm run check && npm test` before committing. `npm run db:generate` after changing `server/db/schema.ts`.
`npm run catalog:sync` re-copies component docs from a cubeui checkout (`CUBEUI_DIR`).

## Roadmap

- **Phase 2:**
  - per-module Tailwind CSS
  - TypeScript type-checking against generated upstream types ([#3](https://github.com/cubicecho/symphony/issues/3))
  - module versions
  - graphql-mcp per-upstream tools
  - module settings
- **Phase 3:**
  - sections and placement over MCP
  - a code editor
  - sign-in
  - schema drift detection
- **Phase 4:** a built-in "Generate module" agent through ai-router.
