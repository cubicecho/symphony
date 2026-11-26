// Two small upstreams that both hold a Team keyed by its slug, with differently named mutations and input
// shapes: "directory" knows teams by name, "billing" knows them as accounts with a plan. Tests serve them
// in-process and reach them through an ExecuteUpstream, as the concept engine will reach real upstreams.
import { buildSchema, GraphQLError, type GraphQLSchema } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import type { Concept } from '../../server/concepts/concept.ts';
import type { ExecuteUpstream } from '../../server/concepts/engine.ts';

export const DIRECTORY_SDL = /* GraphQL */ `
  type Team {
    slug: String!
    name: String!
    memberCount: Int!
  }

  input NewTeam {
    slug: String!
    name: String!
  }

  type Query {
    team(slug: String!): Team
  }

  type Mutation {
    addTeam(input: NewTeam!): Team!
    "Null when there is no such team."
    renameTeam(slug: String!, name: String!): Team
    "Fails when there is no such team."
    removeTeam(slug: String!): Boolean!
  }
`;

export const BILLING_SDL = /* GraphQL */ `
  enum Plan {
    FREE
    PRO
  }

  input LimitsInput {
    seats: Int!
  }

  input AccountInput {
    handle: String!
    displayName: String!
    plan: Plan!
    limits: LimitsInput
  }

  type Account {
    handle: String!
    displayName: String!
    plan: Plan!
    seats: Int
  }

  type Query {
    account(handle: String!): Account
  }

  type Mutation {
    openAccount(input: AccountInput!): Account!
    "Null when there is no such account."
    changeAccount(handle: String!, displayName: String, plan: Plan): Account
    "Null when there is no such account."
    closeAccount(handle: String!): Account
  }
`;

/** A team in the directory. */
export interface DirectoryTeam {
  slug: string;
  name: string;
  memberCount: number;
}

/** An account in billing. */
export interface BillingAccount {
  handle: string;
  displayName: string;
  plan: string;
  seats: number | null;
}

/** The two fixture upstreams, with their data open for tests to read and change. */
export interface ConceptUpstreams {
  teams: Map<string, DirectoryTeam>;
  accounts: Map<string, BillingAccount>;
  /** While true, billing refuses to open accounts. */
  billingRefusesOpen: boolean;
  /** Upstream names that cannot be reached at all. */
  unreachable: Set<string>;
  /** Every request sent, by upstream name, in order. */
  calls: { upstream: string; query: string }[];
  execute: ExecuteUpstream;
}

/** The schemas the concept is validated against, as Symphony would cache them. */
export const CONCEPT_SCHEMAS: ReadonlyMap<string, GraphQLSchema> = new Map([
  ['directory', buildSchema(DIRECTORY_SDL)],
  ['billing', buildSchema(BILLING_SDL)],
]);

/**
 * Serves both fixture upstreams in-process, with empty data.
 *
 * @returns The upstreams, and an execute that reaches them by name.
 */
export function createConceptUpstreams(): ConceptUpstreams {
  const teams = new Map<string, DirectoryTeam>();
  const accounts = new Map<string, BillingAccount>();
  const directory = createSchema({
    typeDefs: DIRECTORY_SDL,
    resolvers: {
      Query: { team: (_: unknown, args: { slug: string }) => teams.get(args.slug) ?? null },
      Mutation: {
        addTeam: (_: unknown, args: { input: { slug: string; name: string } }) => {
          if (teams.has(args.input.slug)) {
            throw new GraphQLError(`The team ${args.input.slug} exists.`);
          }
          const team = { ...args.input, memberCount: 0 };
          teams.set(team.slug, team);
          return team;
        },
        renameTeam: (_: unknown, args: { slug: string; name: string }) => {
          const team = teams.get(args.slug);
          if (team === undefined) {
            return null;
          }
          team.name = args.name;
          return team;
        },
        removeTeam: (_: unknown, args: { slug: string }) => {
          const wasRemoved = teams.delete(args.slug);
          if (wasRemoved === false) {
            throw new GraphQLError(`No team ${args.slug}.`);
          }
          return true;
        },
      },
    },
  });
  const upstreams: ConceptUpstreams = {
    teams,
    accounts,
    billingRefusesOpen: false,
    unreachable: new Set(),
    calls: [],
    execute: async () => ({}),
  };
  const billing = createSchema({
    typeDefs: BILLING_SDL,
    resolvers: {
      Query: { account: (_: unknown, args: { handle: string }) => accounts.get(args.handle) ?? null },
      Mutation: {
        openAccount: (
          _: unknown,
          args: { input: { handle: string; displayName: string; plan: string; limits?: { seats: number } | null } },
        ) => {
          if (upstreams.billingRefusesOpen) {
            throw new GraphQLError('Billing is closed for new accounts.');
          }
          const { limits, ...rest } = args.input;
          const account = { ...rest, seats: limits?.seats ?? null };
          accounts.set(account.handle, account);
          return account;
        },
        changeAccount: (_: unknown, args: { handle: string; displayName?: string | null; plan?: string | null }) => {
          const account = accounts.get(args.handle);
          if (account === undefined) {
            return null;
          }
          account.displayName = args.displayName ?? account.displayName;
          account.plan = args.plan ?? account.plan;
          return account;
        },
        closeAccount: (_: unknown, args: { handle: string }) => {
          const account = accounts.get(args.handle) ?? null;
          accounts.delete(args.handle);
          return account;
        },
      },
    },
  });
  const servers = new Map([
    ['directory', createYoga({ schema: directory, logging: false })],
    ['billing', createYoga({ schema: billing, logging: false })],
  ]);
  upstreams.execute = async (upstream, request) => {
    upstreams.calls.push({ upstream, query: request.query });
    const server = servers.get(upstream);
    if (server === undefined || upstreams.unreachable.has(upstream)) {
      throw new Error(`Could not reach ${upstream}.`);
    }
    const response = await server.fetch('http://fixture.test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    return response.json();
  };
  return upstreams;
}

/**
 * Builds the Team concept over the two fixture upstreams, under any name.
 *
 * @param [name] - The concept's name, so tests can serve two copies side by side.
 * @returns A concept row, before parsing.
 */
export function teamConcept(name = 'Team'): Concept {
  return {
    name,
    fields: [
      { name: 'slug', mode: 'key' },
      { name: 'name', mode: 'shared' },
      { name: 'plan', mode: 'owned', owner: 'billing' },
      { name: 'limits', mode: 'owned', owner: 'billing' },
    ],
    members: [
      {
        upstream: 'directory',
        documents: {
          fetch: 'query ($key: String!) { team(slug: $key) { slug name memberCount } }',
          create: 'mutation ($slug: String!, $name: String!) { addTeam(input: { slug: $slug, name: $name }) { slug } }',
          update: 'mutation ($key: String!, $name: String!) { renameTeam(slug: $key, name: $name) { slug } }',
          delete: 'mutation ($key: String!) { removeTeam(slug: $key) }',
        },
      },
      {
        upstream: 'billing',
        documents: {
          fetch: 'query ($key: String!) { account(handle: $key) { slug: handle name: displayName plan seats } }',
          create: [
            'mutation OpenAccount($key: String!, $name: String!, $plan: Plan!, $limits: LimitsInput) {',
            '  openAccount(input: { handle: $key, displayName: $name, plan: $plan, limits: $limits }) { handle }',
            '}',
          ].join('\n'),
          update: [
            'mutation ($key: String!, $name: String, $plan: Plan) {',
            '  changeAccount(handle: $key, displayName: $name, plan: $plan) { handle }',
            '}',
          ].join('\n'),
          delete: 'mutation ($key: String!) { closeAccount(handle: $key) { handle } }',
        },
      },
    ],
  };
}
