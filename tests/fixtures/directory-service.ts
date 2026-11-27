// A small GraphQL API standing in for a team directory: one of the sources the unified gateway spike merges.
// Its `DirectoryTeam` is the same entity as the billing service's team, under another type name.
import { createSchema, createYoga } from 'graphql-yoga';

/** The directory's SDL. `members` clashes by name, not shape, with the billing service's `members`. */
export const DIRECTORY_SDL = /* GraphQL */ `
  type DirectoryMember {
    handle: String!
    role: String!
  }

  type DirectoryTeam {
    slug: String!
    name: String!
    description: String
    members: [DirectoryMember!]!
  }

  type Query {
    directoryTeam(slug: String!): DirectoryTeam
    directoryTeams(slugs: [String!]!): [DirectoryTeam]!
  }
`;

const TEAMS = [
  {
    slug: 'a',
    name: 'Team A',
    description: 'Builds the widgets.',
    members: [
      { handle: 'ada', role: 'lead' },
      { handle: 'grace', role: 'engineer' },
    ],
  },
  { slug: 'b', name: 'Team B', description: null, members: [{ handle: 'linus', role: 'lead' }] },
];

/** The URL the directory is registered under; directoryFetch answers it whatever the host. */
export const DIRECTORY_URL = 'http://directory.test/graphql';

/** What the directory fixture records about the requests it serves. */
export interface DirectoryFixture {
  /** A `fetch` that answers from the fixture without a network. */
  fetch: typeof fetch;
  /** The headers of every request served, oldest first. */
  requestHeaders: Headers[];
}

/**
 * Builds the directory API behind an in-process `fetch`.
 *
 * @returns The fetch, and the headers it has seen.
 */
export function createDirectoryFixture(): DirectoryFixture {
  const bySlug = (slug: string) => TEAMS.find((team) => team.slug === slug) ?? null;
  const schema = createSchema({
    typeDefs: DIRECTORY_SDL,
    resolvers: {
      Query: {
        directoryTeam: (_: unknown, args: { slug: string }) => bySlug(args.slug),
        directoryTeams: (_: unknown, args: { slugs: string[] }) => args.slugs.map(bySlug),
      },
    },
  });
  const yoga = createYoga({ schema, graphqlEndpoint: '/graphql', logging: false });
  const requestHeaders: Headers[] = [];
  return {
    requestHeaders,
    fetch: (input, init) => {
      const request = new Request(input, init);
      requestHeaders.push(request.headers);
      return Promise.resolve(yoga.fetch(request));
    },
  };
}
