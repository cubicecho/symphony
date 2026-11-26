// Question 5: per-source headers (resolved secrets) injected server-side on every outgoing request.
import { composeSupergraph } from '../../server/gateway/compose.ts';
import { createUnifiedGateway, type UnifiedGateway } from '../../server/gateway/gateway.ts';
import type { Source } from '../../server/gateway/sources.ts';
import {
  BILLING_SOURCE,
  createUnifiedFixtures,
  DIRECTORY_SOURCE,
  postGraphQL,
  type UnifiedFixtures,
} from '../fixtures/unified-sources.ts';

const DIRECTORY_TOKEN = 'Bearer directory-secret';
const BILLING_KEY = 'billing-secret';

let fixtures: UnifiedFixtures;
let gateway: UnifiedGateway;

beforeAll(async () => {
  fixtures = createUnifiedFixtures();
  const sources: Source[] = [
    { ...DIRECTORY_SOURCE, headers: { authorization: DIRECTORY_TOKEN } },
    { ...BILLING_SOURCE, headers: { 'x-api-key': BILLING_KEY } },
  ];
  const supergraph = await composeSupergraph(sources, { fetch: fixtures.fetch });
  gateway = createUnifiedGateway({ supergraph, fetch: fixtures.fetch });
});
afterAll(() => gateway.dispose());

describe('per-source headers', () => {
  it("sends each source its own headers and none of the other's", async () => {
    const directoryBefore = fixtures.directory.requestHeaders.length;
    const billingBefore = fixtures.billing.requestHeaders.length;
    const body = await postGraphQL(gateway.runtime, '{ team(slug: "a") { name plan } }');
    expect(body.errors).toBeUndefined();

    const directorySeen = fixtures.directory.requestHeaders.slice(directoryBefore);
    const billingSeen = fixtures.billing.requestHeaders.slice(billingBefore);
    expect(directorySeen.length).toBeGreaterThan(0);
    expect(billingSeen.length).toBeGreaterThan(0);
    expect(directorySeen.map((headers) => headers.get('authorization'))).toEqual(
      directorySeen.map(() => DIRECTORY_TOKEN),
    );
    expect(directorySeen.map((headers) => headers.get('x-api-key'))).toEqual(directorySeen.map(() => null));
    expect(billingSeen.map((headers) => headers.get('x-api-key'))).toEqual(billingSeen.map(() => BILLING_KEY));
    expect(billingSeen.map((headers) => headers.get('authorization'))).toEqual(billingSeen.map(() => null));
  });

  it("never forwards the caller's own headers", async () => {
    const directoryBefore = fixtures.directory.requestHeaders.length;
    await gateway.runtime.fetch('http://gateway.test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=caller' },
      body: JSON.stringify({ query: '{ team(slug: "a") { name } }' }),
    });
    const directorySeen = fixtures.directory.requestHeaders.slice(directoryBefore);
    expect(directorySeen.map((headers) => headers.get('cookie'))).toEqual(directorySeen.map(() => null));
  });
});
