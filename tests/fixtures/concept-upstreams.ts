// Two small upstreams that both hold a Team under one Symphony UUID, with differently named mutations and
// input shapes: "directory" knows teams by slug and name, "billing" knows them as accounts with a handle and a
// plan. Tests serve them in-process and reach them through an ExecuteUpstream, as the concept engine will
// reach real upstreams.
import { buildSchema, GraphQLError, type GraphQLSchema } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import type { Concept } from '../../server/concepts/concept.ts';
import type { ExecuteUpstream } from '../../server/concepts/engine.ts';

export const DIRECTORY_SDL = /* GraphQL */ `
  type Team {
    id: ID!
    slug: String!
    name: String!
    memberCount: Int!
  }

  input NewTeam {
    id: ID!
    slug: String!
    name: String!
  }

  type Query {
    team(id: ID!): Team
  }

  type Mutation {
    addTeam(input: NewTeam!): Team!
    "Null when there is no such team. Leave a field out to keep it."
    renameTeam(id: ID!, name: String, slug: String): Team
    "Fails when there is no such team."
    removeTeam(id: ID!): Boolean!
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
    id: ID!
    handle: String!
    displayName: String!
    plan: Plan!
    limits: LimitsInput
  }

  type Account {
    id: ID!
    handle: String!
    displayName: String!
    plan: Plan!
    seats: Int
  }

  type Query {
    account(id: ID!): Account
  }

  type Mutation {
    openAccount(input: AccountInput!): Account!
    "Null when there is no such account."
    changeAccount(id: ID!, handle: String, displayName: String, plan: Plan): Account
    "Null when there is no such account."
    closeAccount(id: ID!): Account
  }
`;

/** A team in the directory. */
export interface DirectoryTeam {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
}

/** An account in billing. */
export interface BillingAccount {
  id: string;
  handle: string;
  displayName: string;
  plan: string;
  seats: number | null;
}

/** The two fixture upstreams, with their data open for tests to read and change. */
export interface ConceptUpstreams {
  /** Teams by id. */
  teams: Map<string, DirectoryTeam>;
  /** Accounts by id. */
  accounts: Map<string, BillingAccount>;
  /** While true, billing refuses to open accounts. */
  billingRefusesOpen: boolean;
  /** Upstream names that cannot be reached at all. */
  unreachable: Set<string>;
  /** Every request sent, by upstream name, in order. */
  calls: { upstream: string; query: string }[];
  execute: ExecuteUpstream;
  /** Reaches the same servers over HTTP-shaped requests, at `http://<upstream>.test/graphql`, for a gateway. */
  fetch: typeof fetch;
}

/**
 * The URL a gateway reaches one fixture upstream at.
 *
 * @param upstream - Its name.
 * @returns Its GraphQL endpoint.
 */
export function conceptUpstreamUrl(upstream: string): string {
  return `http://${upstream}.test/graphql`;
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
      Query: { team: (_: unknown, args: { id: string }) => teams.get(args.id) ?? null },
      Mutation: {
        addTeam: (_: unknown, args: { input: { id: string; slug: string; name: string } }) => {
          if (teams.has(args.input.id)) {
            throw new GraphQLError(`The team ${args.input.id} exists.`);
          }
          const team = { ...args.input, memberCount: 0 };
          teams.set(team.id, team);
          return team;
        },
        renameTeam: (_: unknown, args: { id: string; name?: string | null; slug?: string | null }) => {
          const team = teams.get(args.id);
          if (team === undefined) {
            return null;
          }
          team.name = args.name ?? team.name;
          team.slug = args.slug ?? team.slug;
          return team;
        },
        removeTeam: (_: unknown, args: { id: string }) => {
          const wasRemoved = teams.delete(args.id);
          if (wasRemoved === false) {
            throw new GraphQLError(`No team ${args.id}.`);
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
    fetch: async () => new Response(null, { status: 404 }),
  };
  const billing = createSchema({
    typeDefs: BILLING_SDL,
    resolvers: {
      Query: { account: (_: unknown, args: { id: string }) => accounts.get(args.id) ?? null },
      Mutation: {
        openAccount: (
          _: unknown,
          args: {
            input: { id: string; handle: string; displayName: string; plan: string; limits?: { seats: number } | null };
          },
        ) => {
          if (upstreams.billingRefusesOpen) {
            throw new GraphQLError('Billing is closed for new accounts.');
          }
          const { limits, ...rest } = args.input;
          const account = { ...rest, seats: limits?.seats ?? null };
          accounts.set(account.id, account);
          return account;
        },
        changeAccount: (
          _: unknown,
          args: { id: string; handle?: string | null; displayName?: string | null; plan?: string | null },
        ) => {
          const account = accounts.get(args.id);
          if (account === undefined) {
            return null;
          }
          account.handle = args.handle ?? account.handle;
          account.displayName = args.displayName ?? account.displayName;
          account.plan = args.plan ?? account.plan;
          return account;
        },
        closeAccount: (_: unknown, args: { id: string }) => {
          const account = accounts.get(args.id) ?? null;
          accounts.delete(args.id);
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
  upstreams.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const server = servers.get(url.hostname.replace(/\.test$/, ''));
    if (server === undefined) {
      return new Response(null, { status: 404 });
    }
    return server.fetch(new Request(input, init));
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
      { name: 'slug', mode: 'shared' },
      { name: 'name', mode: 'shared' },
      { name: 'plan', mode: 'owned', owner: 'billing' },
      { name: 'limits', mode: 'owned', owner: 'billing' },
    ],
    members: [
      {
        upstream: 'directory',
        documents: {
          fetch: 'query ($id: ID!) { team(id: $id) { id slug name memberCount } }',
          create: [
            'mutation ($id: ID!, $slug: String!, $name: String!) {',
            '  addTeam(input: { id: $id, slug: $slug, name: $name }) { id }',
            '}',
          ].join('\n'),
          update:
            'mutation ($id: ID!, $slug: String, $name: String) { renameTeam(id: $id, slug: $slug, name: $name) { id } }',
          delete: 'mutation ($id: ID!) { removeTeam(id: $id) }',
        },
      },
      {
        upstream: 'billing',
        documents: {
          fetch: 'query ($id: ID!) { account(id: $id) { id slug: handle name: displayName plan seats } }',
          create: [
            'mutation OpenAccount($id: ID!, $slug: String!, $name: String!, $plan: Plan!, $limits: LimitsInput) {',
            '  openAccount(input: { id: $id, handle: $slug, displayName: $name, plan: $plan, limits: $limits }) { id }',
            '}',
          ].join('\n'),
          update: [
            'mutation ($id: ID!, $slug: String, $name: String, $plan: Plan) {',
            '  changeAccount(id: $id, handle: $slug, displayName: $name, plan: $plan) { id }',
            '}',
          ].join('\n'),
          delete: 'mutation ($id: ID!) { closeAccount(id: $id) { id } }',
        },
      },
    ],
  };
}
