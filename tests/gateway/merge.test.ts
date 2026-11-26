// Question 1: one `Team` merged by `slug` from a plain GraphQL source and an OpenAPI source.
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
  const supergraph = await composeSupergraph([DIRECTORY_SOURCE, BILLING_SOURCE], { fetch: fixtures.fetch });
  gateway = createUnifiedGateway({ supergraph, fetch: fixtures.fetch });
});
afterAll(() => gateway.dispose());

describe('merging an entity across non-federation sources', () => {
  it('composes both renamed types into one Team keyed by slug', () => {
    expect(gateway.supergraph.sdl).toContain('@join__type(graph: BILLING, key: "slug")');
    expect(gateway.supergraph.sdl).toContain('@join__type(graph: DIRECTORY, key: "slug")');
    expect(gateway.supergraph.sdl).toContain('@merge(subgraph: "billing", keyField: "slug"');
  });

  it('fills one Team from both sources', async () => {
    const body = await postGraphQL(
      gateway.runtime,
      '{ team(slug: "a") { slug name description plan directoryMembers { handle } billingMembers } }',
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.team).toEqual({
      slug: 'a',
      name: 'Team A',
      description: 'Builds the widgets.',
      plan: 'pro',
      directoryMembers: [{ handle: 'ada' }, { handle: 'grace' }],
      billingMembers: 12,
    });
  });

  it('enters through the other source too', async () => {
    const body = await postGraphQL(gateway.runtime, '{ billingTeam(slug: "b") { plan description } }');
    expect(body.errors).toBeUndefined();
    expect(body.data?.billingTeam).toEqual({ plan: 'free', description: null });
  });
});
