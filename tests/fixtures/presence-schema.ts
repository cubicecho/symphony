// An in-memory schema standing in for a generated subgraph: it adds `presence` to the unified `Team` and owns a
// mutation, and the gateway executes it in-process with no HTTP route.
import { createSchema } from 'graphql-yoga';
import type { SchemaSource } from '../../server/gateway/sources.ts';

const PRESENCE_SDL = /* GraphQL */ `
  type Team {
    slug: String!
    presence: String
  }

  type Query {
    teamPresence(slug: String!): Team
  }

  type Mutation {
    setPresence(slug: String!, presence: String!): Team!
  }
`;

/** The presence source, and what its resolvers saw. */
export interface PresenceFixture {
  source: SchemaSource;
  /** The slugs `setPresence` was called with, oldest first. */
  mutations: string[];
}

/**
 * Builds the presence schema with fresh state.
 *
 * @returns The source and its call log.
 */
export function createPresenceFixture(): PresenceFixture {
  const presenceBySlug = new Map([['a', 'online']]);
  const mutations: string[] = [];
  const schema = createSchema({
    typeDefs: PRESENCE_SDL,
    resolvers: {
      Query: {
        teamPresence: (_: unknown, args: { slug: string }) => ({
          slug: args.slug,
          presence: presenceBySlug.get(args.slug) ?? null,
        }),
      },
      Mutation: {
        setPresence: (_: unknown, args: { slug: string; presence: string }) => {
          mutations.push(args.slug);
          presenceBySlug.set(args.slug, args.presence);
          return { slug: args.slug, presence: args.presence };
        },
      },
    },
  });
  return {
    mutations,
    source: {
      name: 'presence',
      kind: 'schema',
      schema,
      mergeKeys: [{ type: 'Team', keyField: 'slug', lookupField: 'teamPresence' }],
    },
  };
}
