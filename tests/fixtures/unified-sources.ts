// Sources for the unified gateway tests: the directory (GraphQL) and billing (OpenAPI) fixtures, described as gateway
// sources that merge their teams into one `Team`, and one fetch that answers both without a network.
import type { GatewayRuntime } from '@graphql-hive/gateway-runtime';
import type { GraphQLSource, OpenAPISource } from '../../server/gateway/sources.ts';
import { BILLING_SPEC_URL, BILLING_URL, type BillingFixture, createBillingFixture } from './billing-service.ts';
import { createDirectoryFixture, DIRECTORY_SDL, DIRECTORY_URL, type DirectoryFixture } from './directory-service.ts';

/** The directory as a source: `DirectoryTeam` becomes `Team`, its lookup becomes `Query.team`. */
export const DIRECTORY_SOURCE: GraphQLSource = {
  name: 'directory',
  kind: 'graphql',
  endpoint: DIRECTORY_URL,
  sdl: DIRECTORY_SDL,
  renames: {
    types: { DirectoryTeam: 'Team' },
    fields: { 'DirectoryTeam.members': 'directoryMembers', 'Query.directoryTeam': 'team' },
  },
  mergeKeys: [{ type: 'Team', keyField: 'slug', lookupField: 'team' }],
};

/** The billing service as a source: `BillingTeam` becomes `Team`, looked up through `Query.billingTeam`. */
export const BILLING_SOURCE: OpenAPISource = {
  name: 'billing',
  kind: 'openapi',
  endpoint: BILLING_URL,
  specUrl: BILLING_SPEC_URL,
  renames: { types: { BillingTeam: 'Team' }, fields: { 'BillingTeam.members': 'billingMembers' } },
  mergeKeys: [{ type: 'Team', keyField: 'slug', lookupField: 'billingTeam' }],
};

/** Both fixtures, and a fetch that routes to them by URL. */
export interface UnifiedFixtures {
  directory: DirectoryFixture;
  billing: BillingFixture;
  fetch: typeof fetch;
}

/**
 * Builds fresh fixtures for one test.
 *
 * @returns The fixtures and their fetch.
 */
export function createUnifiedFixtures(): UnifiedFixtures {
  const directory = createDirectoryFixture();
  const billing = createBillingFixture();
  return {
    directory,
    billing,
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const target = url.startsWith(BILLING_URL) ? billing : directory;
      return target.fetch(input, init);
    },
  };
}

/** A GraphQL response, as the tests read it. */
export interface GraphQLBody {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}

/**
 * Sends one operation to a gateway runtime in-process.
 *
 * @param runtime - The runtime.
 * @param query - The operation.
 * @param [variables] - Its variables.
 * @returns The response body.
 */
export async function postGraphQL(
  runtime: GatewayRuntime,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLBody> {
  const response = await runtime.fetch('http://gateway.test/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}
