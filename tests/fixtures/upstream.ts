// A small GraphQL API standing in for a wrapped (upstream) one: customers and their orders. Tests serve
// it in-process, and `npm run fixture:upstream` serves it on a port for trying Symphony by hand.
import { createSchema, createYoga, type YogaServerInstance } from 'graphql-yoga';

/** The fixture's SDL. */
export const FIXTURE_SDL = /* GraphQL */ `
  "Someone who places orders."
  type Customer {
    id: ID!
    name: String!
    email: String!
    orders: [Order!]!
  }

  enum OrderStatus {
    PENDING
    SHIPPED
    DELIVERED
  }

  type Order {
    id: ID!
    "In cents."
    total: Int!
    status: OrderStatus!
    "ISO 8601."
    placedAt: String!
    customer: Customer!
  }

  type Query {
    customers: [Customer!]!
    customer(id: ID!): Customer
    "Newest first."
    orders(first: Int = 20, status: OrderStatus): [Order!]!
  }

  type Mutation {
    shipOrder(id: ID!): Order!
  }
`;

interface OrderRow {
  id: string;
  total: number;
  status: string;
  placedAt: string;
  customerId: string;
}

const CUSTOMERS = [
  { id: 'c1', name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: 'c2', name: 'Grace Hopper', email: 'grace@example.com' },
];

/**
 * Makes fresh sample orders, so one test's mutation never shows in another.
 *
 * @returns The orders, newest first.
 */
function sampleOrders(): OrderRow[] {
  return [
    { id: 'o3', total: 4200, status: 'PENDING', placedAt: '2026-11-20T10:00:00Z', customerId: 'c1' },
    { id: 'o2', total: 1999, status: 'SHIPPED', placedAt: '2026-11-18T09:30:00Z', customerId: 'c2' },
    { id: 'o1', total: 750, status: 'DELIVERED', placedAt: '2026-11-10T15:45:00Z', customerId: 'c1' },
  ];
}

/** What the fixture server checks: when set, every request must carry `authorization: Bearer <token>`. */
export interface FixtureOptions {
  token?: string;
}

/**
 * Builds the fixture API as a Yoga server, which is also a fetch handler.
 *
 * @param [options] - The bearer token it demands, if any.
 * @returns The server.
 */
export function createFixtureUpstream(options: FixtureOptions = {}): YogaServerInstance<object, object> {
  const orders = sampleOrders();
  const customerOf = (order: OrderRow) => CUSTOMERS.find((customer) => customer.id === order.customerId);
  const schema = createSchema({
    typeDefs: FIXTURE_SDL,
    resolvers: {
      Query: {
        customers: () => CUSTOMERS,
        customer: (_: unknown, args: { id: string }) => CUSTOMERS.find((customer) => customer.id === args.id) ?? null,
        orders: (_: unknown, args: { first: number; status?: string | null }) =>
          orders.filter((order) => args.status == null || order.status === args.status).slice(0, args.first),
      },
      Mutation: {
        shipOrder: (_: unknown, args: { id: string }) => {
          const order = orders.find((one) => one.id === args.id);
          if (order === undefined) {
            throw new Error(`No order ${args.id}.`);
          }
          order.status = 'SHIPPED';
          return order;
        },
      },
      Customer: {
        orders: (customer: { id: string }) => orders.filter((order) => order.customerId === customer.id),
      },
      Order: { customer: customerOf },
    },
  });
  return createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    logging: false,
    plugins: [
      {
        onRequest: ({ request, endResponse }) => {
          const isOpen = options.token === undefined;
          if (isOpen) {
            return;
          }
          const isAuthorized = request.headers.get('authorization') === `Bearer ${options.token}`;
          if (isAuthorized === false) {
            endResponse(new Response('unauthorized', { status: 401 }));
          }
        },
      },
    ],
  });
}

/**
 * A `fetch` that answers from the fixture without a network, for injecting into the upstream service.
 *
 * @param [options] - Passed to the fixture.
 * @returns The fetch function.
 */
export function fixtureFetch(options: FixtureOptions = {}): typeof fetch {
  const yoga = createFixtureUpstream(options);
  return (input, init) => Promise.resolve(yoga.fetch(new Request(input, init)));
}

/** The URL tests register the fixture under; fixtureFetch answers it whatever the host. */
export const FIXTURE_URL = 'http://fixture.test/graphql';
