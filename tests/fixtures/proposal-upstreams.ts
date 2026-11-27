// Three small upstreams for the concept proposer: "catalog" and "warehouse" both hold widgets, each under its own
// prefix (CatalogWidget, AcmeWidget), the warehouse's with a create that needs an argument no concept field matches; "storefront" holds
// gizmos, which the warehouse has too but without an `id: ID!`. Served in-process for the app-level tests.
import { buildSchema, type GraphQLSchema } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';

export const CATALOG_SDL = /* GraphQL */ `
  type CatalogWidget {
    id: ID!
    name: String!
    price: Float
    sku: String!
  }

  input CatalogWidgetInput {
    id: ID!
    name: String!
    price: Float
    sku: String!
  }

  type Query {
    catalogWidget(id: ID!): CatalogWidget
    catalogWidgets: [CatalogWidget!]!
  }

  type Mutation {
    createCatalogWidget(input: CatalogWidgetInput!): CatalogWidget!
    updateCatalogWidget(id: ID!, name: String, price: Float, sku: String): CatalogWidget
    deleteCatalogWidget(id: ID!): Boolean!
  }
`;

export const WAREHOUSE_SDL = /* GraphQL */ `
  type AcmeWidget {
    id: ID!
    name: String!
    stock: Int!
  }

  "Keyed by its own uuid, not an id: ID!, so it can't be a member."
  type AcmeGizmo {
    uuid: String!
    title: String!
  }

  type Query {
    acmeWidget(id: ID!): AcmeWidget
    acmeGizmo(uuid: String!): AcmeGizmo
  }

  type Mutation {
    "location matches no concept field, so the proposer can't write this create."
    createAcmeWidget(id: ID!, name: String!, stock: Int!, location: String!): AcmeWidget!
    updateAcmeWidget(id: ID!, name: String, stock: Int): AcmeWidget
    deleteAcmeWidget(id: ID!): AcmeWidget
  }
`;

export const STOREFRONT_SDL = /* GraphQL */ `
  type Gizmo {
    id: ID!
    title: String!
  }

  type Query {
    gizmo(id: ID!): Gizmo
  }
`;

/** The fixture upstreams' names and SDLs, in the order they are registered. */
export const PROPOSAL_SDLS: ReadonlyArray<readonly [string, string]> = [
  ['catalog', CATALOG_SDL],
  ['warehouse', WAREHOUSE_SDL],
  ['storefront', STOREFRONT_SDL],
];

/** The fixture schemas, by upstream name, as Symphony would cache them. */
export const PROPOSAL_SCHEMAS: ReadonlyMap<string, GraphQLSchema> = new Map(
  PROPOSAL_SDLS.map(([name, sdl]) => [name, buildSchema(sdl)]),
);

/**
 * The URL a fixture upstream is registered at.
 *
 * @param upstream - Its name.
 * @returns Its GraphQL endpoint.
 */
export function proposalUpstreamUrl(upstream: string): string {
  return `http://${upstream}.test/graphql`;
}

/** A row any fixture upstream stores. */
type Row = Record<string, unknown> & { id: string };

/**
 * Serves the three fixture upstreams in-process, each keeping its rows in a map, with a fetch that reaches them by
 * host name.
 *
 * @returns The fetch.
 */
export function createProposalUpstreams(): { fetch: typeof fetch } {
  const widgets = new Map<string, Row>();
  const stocked = new Map<string, Row>();
  const gizmos = new Map<string, Row>();
  /**
   * Merges a patch into a stored row, leaving out what the patch does not set.
   *
   * @param rows - The rows.
   * @param patch - The id and the values to set.
   * @returns The row, or null when there is none with the id.
   */
  const patch = (rows: Map<string, Row>, { id, ...values }: Row): Row | null => {
    const row = rows.get(id);
    if (row === undefined) {
      return null;
    }
    Object.assign(row, Object.fromEntries(Object.entries(values).filter(([, value]) => value != null)));
    return row;
  };
  const catalog = createSchema({
    typeDefs: CATALOG_SDL,
    resolvers: {
      Query: {
        catalogWidget: (_: unknown, args: { id: string }) => widgets.get(args.id) ?? null,
        catalogWidgets: () => [...widgets.values()],
      },
      Mutation: {
        createCatalogWidget: (_: unknown, args: { input: Row }) => {
          widgets.set(args.input.id, { ...args.input });
          return args.input;
        },
        updateCatalogWidget: (_: unknown, args: Row) => patch(widgets, args),
        deleteCatalogWidget: (_: unknown, args: { id: string }) => widgets.delete(args.id),
      },
    },
  });
  const warehouse = createSchema({
    typeDefs: WAREHOUSE_SDL,
    resolvers: {
      Query: {
        acmeWidget: (_: unknown, args: { id: string }) => stocked.get(args.id) ?? null,
        acmeGizmo: () => null,
      },
      Mutation: {
        createAcmeWidget: (_: unknown, args: Row) => {
          stocked.set(args.id, { ...args });
          return args;
        },
        updateAcmeWidget: (_: unknown, args: Row) => patch(stocked, args),
        deleteAcmeWidget: (_: unknown, args: { id: string }) => {
          const row = stocked.get(args.id) ?? null;
          stocked.delete(args.id);
          return row;
        },
      },
    },
  });
  const storefront = createSchema({
    typeDefs: STOREFRONT_SDL,
    resolvers: { Query: { gizmo: (_: unknown, args: { id: string }) => gizmos.get(args.id) ?? null } },
  });
  const servers = new Map([
    ['catalog', createYoga({ schema: catalog, logging: false })],
    ['warehouse', createYoga({ schema: warehouse, logging: false })],
    ['storefront', createYoga({ schema: storefront, logging: false })],
  ]);
  return {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const server = servers.get(new URL(request.url).hostname.replace(/\.test$/, ''));
      return server === undefined ? new Response(null, { status: 404 }) : server.fetch(request);
    },
  };
}

/** The create the warehouse's draft is missing, as an agent would write it: `location` is given as a literal. */
export const WAREHOUSE_CREATE =
  'mutation ($id: ID!, $name: String!, $stock: Int!) { createAcmeWidget(id: $id, name: $name, stock: $stock, location: "main") { id } }';
