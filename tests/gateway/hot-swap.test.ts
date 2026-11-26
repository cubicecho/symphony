// Question 3: adding a source while the gateway runs, served by the same runtime without a restart.
import { composeSupergraph } from '../../server/gateway/compose.ts';
import { createUnifiedGateway, type UnifiedGateway } from '../../server/gateway/gateway.ts';
import {
  BILLING_SOURCE,
  createUnifiedFixtures,
  DIRECTORY_SOURCE,
  postGraphQL,
  type UnifiedFixtures,
} from '../fixtures/unified-sources.ts';

let fixtures: UnifiedFixtures;
let gateway: UnifiedGateway;

beforeAll(async () => {
  fixtures = createUnifiedFixtures();
  const supergraph = await composeSupergraph([DIRECTORY_SOURCE], { fetch: fixtures.fetch });
  gateway = createUnifiedGateway({ supergraph, fetch: fixtures.fetch });
});
afterAll(() => gateway.dispose());

describe('recomposing at runtime', () => {
  it('serves the new source from the same runtime once recomposed', async () => {
    const runtime = gateway.runtime;
    const before = await postGraphQL(runtime, '{ team(slug: "a") { name plan } }');
    expect(before.errors?.[0]?.message).toContain('Cannot query field "plan"');

    await gateway.recompose([DIRECTORY_SOURCE, BILLING_SOURCE]);

    expect(gateway.runtime).toBe(runtime);
    const after = await postGraphQL(runtime, '{ team(slug: "a") { name plan } }');
    expect(after.errors).toBeUndefined();
    expect(after.data?.team).toEqual({ name: 'Team A', plan: 'pro' });
  });

  it('drops a removed source on the next swap', async () => {
    const supergraph = await composeSupergraph([DIRECTORY_SOURCE], { fetch: fixtures.fetch });
    await gateway.swap(supergraph);
    const body = await postGraphQL(gateway.runtime, '{ team(slug: "a") { plan } }');
    expect(body.errors?.[0]?.message).toContain('Cannot query field "plan"');
  });
});
