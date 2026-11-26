// A small REST API standing in for a billing service, described by an OpenAPI 3 spec: the second source the
// unified gateway spike merges. Its `BillingTeam` is the same entity as the directory's team.

/** Where the billing service is registered; the fixture's fetch answers it whatever the host. */
export const BILLING_URL = 'http://billing.test';

/** Where the fixture serves its own OpenAPI description. */
export const BILLING_SPEC_URL = `${BILLING_URL}/openapi.json`;

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

/** The billing service's OpenAPI 3 description. `members` is a head count here, a list in the directory. */
export const BILLING_OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Billing', version: '1.0.0' },
  servers: [{ url: BILLING_URL }],
  paths: {
    '/teams/{slug}': {
      get: {
        operationId: 'billingTeam',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The team.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingTeam' } } },
          },
        },
      },
    },
    '/teams/{slug}/invoices': {
      get: {
        operationId: 'teamInvoices',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: "The team's invoices, newest first.",
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Invoice' } } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      BillingTeam: {
        type: 'object',
        required: ['slug', 'name', 'plan', 'members'],
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
          plan: { type: 'string' },
          members: { type: 'integer', description: 'Paid seats.' },
        },
      },
      Invoice: {
        type: 'object',
        required: ['id', 'amountCents'],
        properties: { id: { type: 'string' }, amountCents: { type: 'integer' } },
      },
    },
  },
};

const TEAMS = [
  { slug: 'a', name: 'Team A', plan: 'pro', members: 12 },
  { slug: 'b', name: 'Team B', plan: 'free', members: 3 },
];

const INVOICES: Record<string, { id: string; amountCents: number }[]> = {
  a: [
    { id: 'inv-2', amountCents: 4900 },
    { id: 'inv-1', amountCents: 4900 },
  ],
  b: [],
};

/** What the billing fixture records about the requests it serves. */
export interface BillingFixture {
  /** A `fetch` that answers from the fixture without a network. */
  fetch: typeof fetch;
  /** The headers of every request served, oldest first. */
  requestHeaders: Headers[];
}

/**
 * Answers one billing request.
 *
 * @param request - The request.
 * @returns The JSON response, or a 404.
 */
function answer(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === '/openapi.json') {
    return Response.json(BILLING_OPENAPI, { status: HTTP_OK });
  }
  const invoicesMatch = path.match(/^\/teams\/([^/]+)\/invoices$/);
  if (invoicesMatch) {
    return Response.json(INVOICES[invoicesMatch[1]] ?? [], { status: HTTP_OK });
  }
  const teamMatch = path.match(/^\/teams\/([^/]+)$/);
  const team = teamMatch ? TEAMS.find((one) => one.slug === teamMatch[1]) : undefined;
  if (team) {
    return Response.json(team, { status: HTTP_OK });
  }
  return Response.json({ error: `No route ${path}.` }, { status: HTTP_NOT_FOUND });
}

/**
 * Builds the billing API behind an in-process `fetch`.
 *
 * @returns The fetch, and the headers it has seen.
 */
export function createBillingFixture(): BillingFixture {
  const requestHeaders: Headers[] = [];
  return {
    requestHeaders,
    fetch: (input, init) => {
      const request = new Request(input, init);
      requestHeaders.push(request.headers);
      return Promise.resolve(answer(request));
    },
  };
}
