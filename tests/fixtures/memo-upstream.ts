// A small upstream holding memos, each identified by an `id: ID!`, for the concept, wiring and unified gateway tests.
// It is served in-process at any URL; `retitleMemo` can be dropped from its schema to show a saved concept breaking.
import { buildSchema, type GraphQLSchema } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import type { Upstream } from '../../server/core/services.ts';
import type { EffectiveWiring, SourceWiring } from '../../server/gateway/wiring.ts';
import type { WiringServiceDeps } from '../../server/gateway/wiring-service.ts';

/** The memo upstream's SDL. */
export const MEMO_SDL = /* GraphQL */ `
  type Memo {
    id: ID!
    title: String!
  }

  type Query {
    memo(id: ID!): Memo
    memos: [Memo!]!
  }

  type Mutation {
    addMemo(id: ID!, title: String!): Memo!
    "Null when there is no such memo."
    retitleMemo(id: ID!, title: String): Memo
    dropMemo(id: ID!): Boolean!
  }
`;

/** The same, after an upstream change dropped `retitleMemo`. */
export const MEMO_SDL_WITHOUT_RETITLE = MEMO_SDL.replace(
  /\s*"Null when there is no such memo."\s*retitleMemo[^\n]*/,
  '',
);

/** The memo upstream's name in the tests: spaces are allowed in Symphony names, but not in GraphQL names. */
export const MEMO_UPSTREAM = 'field notes';

/** Where the tests register the memo upstream. */
export const MEMO_URL = 'http://memos.test/graphql';

/** The memo upstream, with its data and schema open for tests to change. */
export interface MemoUpstream {
  memos: Map<string, { id: string; title: string }>;
  /** While true, the schema has no `retitleMemo`. */
  withoutRetitle: boolean;
  /** Every header the last request carried. */
  lastHeaders: Headers | null;
  fetch: typeof fetch;
}

/**
 * Serves the memo upstream in-process.
 *
 * @returns The upstream and a fetch that answers every URL with it.
 */
export function createMemoUpstream(): MemoUpstream {
  const memos = new Map([['m1', { id: 'm1', title: 'First' }]]);
  const resolvers = {
    Query: {
      memo: (_: unknown, args: { id: string }) => memos.get(args.id) ?? null,
      memos: () => [...memos.values()],
    },
    Mutation: {
      addMemo: (_: unknown, args: { id: string; title: string }) => {
        memos.set(args.id, args);
        return args;
      },
      retitleMemo: (_: unknown, args: { id: string; title?: string | null }) => {
        const memo = memos.get(args.id);
        if (memo !== undefined && typeof args.title === 'string') {
          memo.title = args.title;
        }
        return memo ?? null;
      },
      dropMemo: (_: unknown, args: { id: string }) => memos.delete(args.id),
    },
  };
  const { retitleMemo: _retitle, ...mutationsWithoutRetitle } = resolvers.Mutation;
  const full = createYoga({ schema: createSchema({ typeDefs: MEMO_SDL, resolvers }), logging: false });
  const reduced = createYoga({
    schema: createSchema({
      typeDefs: MEMO_SDL_WITHOUT_RETITLE,
      resolvers: { ...resolvers, Mutation: mutationsWithoutRetitle },
    }),
    logging: false,
  });
  const upstream: MemoUpstream = {
    memos,
    withoutRetitle: false,
    lastHeaders: null,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      upstream.lastHeaders = request.headers;
      const yoga = upstream.withoutRetitle ? reduced : full;
      return yoga.fetch(request);
    },
  };
  return upstream;
}

/**
 * A concept over the memo upstream, in today's definition shape with the entity bound by `$id`.
 * After the Symphony-UUID track merges, only this builder should need to change.
 *
 * @param [name] - The concept's name.
 * @param [documents] - Member documents to replace.
 * @param [upstream] - The member's upstream name.
 * @returns The definition, as JSON a client would send.
 */
export function noteConcept(
  name = 'Note',
  documents: Readonly<Record<string, string>> = {},
  upstream = MEMO_UPSTREAM,
): Record<string, unknown> {
  return {
    name,
    fields: [
      { name: 'id', mode: 'key' },
      { name: 'title', mode: 'shared' },
    ],
    members: [
      {
        upstream,
        documents: {
          fetch: 'query ($id: ID!) { memo(id: $id) { id title } }',
          create: 'mutation ($id: ID!, $title: String!) { addMemo(id: $id, title: $title) { id } }',
          update: 'mutation ($id: ID!, $title: String) { retitleMemo(id: $id, title: $title) { id } }',
          delete: 'mutation ($id: ID!) { dropMemo(id: $id) }',
          ...documents,
        },
      },
    ],
  };
}

/**
 * Builds an upstream as the upstream service would hand it out, over an SDL.
 *
 * @param name - Its name.
 * @param sdl - Its cached schema.
 * @param [headers] - Its stored headers.
 * @returns The upstream.
 */
export function cachedUpstream(name: string, sdl: string, headers: Upstream['headers'] = []): Upstream {
  const schema: GraphQLSchema = buildSchema(sdl);
  return {
    id: `id-${name}`,
    name,
    url: MEMO_URL,
    headers,
    schema: { schema, sdl, hash: name, typeCount: 1, fetchedAt: new Date() },
  };
}

/**
 * Wiring functions standing in for wiring.ts while it is a stub: no generated renames or keys, one empty wiring per
 * member upstream, and overrides laid over it entry by entry. Tests switch to the real ones by dropping these.
 */
export const FAKE_WIRING_FUNCTIONS: Required<Pick<WiringServiceDeps, 'deriveWiring' | 'applyWiringOverrides'>> = {
  deriveWiring: (concepts) => ({
    wiring: [...new Set(concepts.flatMap((concept) => concept.members.map((member) => member.upstream)))].map(
      (upstream): SourceWiring => ({ upstream, renames: { types: {}, fields: {} }, mergeKeys: [] }),
    ),
    problems: [],
  }),
  applyWiringOverrides: (generated, overrides) => {
    const sources = [...new Set([...generated.map((one) => one.upstream), ...overrides.map((one) => one.upstream)])];
    return sources.map((upstream): EffectiveWiring => {
      const base = generated.find((one) => one.upstream === upstream) ?? null;
      const override = overrides.find((one) => one.upstream === upstream) ?? null;
      const kept = (renames: Readonly<Record<string, string | null>> = {}) =>
        Object.fromEntries(Object.entries(renames).filter((entry): entry is [string, string] => entry[1] !== null));
      return {
        upstream,
        renames: {
          types: { ...base?.renames.types, ...kept(override?.renames?.types) },
          fields: { ...base?.renames.fields, ...kept(override?.renames?.fields) },
        },
        mergeKeys: [...(base?.mergeKeys ?? []), ...(override?.mergeKeys ?? [])],
        generated: base,
        override,
        origins: {},
      };
    });
  },
};
