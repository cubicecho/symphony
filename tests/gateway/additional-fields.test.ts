// Question 2: a cross-source field declared in `additionalTypeDefs` and resolved through `@resolveTo`.
import { composeSupergraph, SupergraphCompositionError } from '../../server/gateway/compose.ts';
import { createUnifiedGateway, type UnifiedGateway } from '../../server/gateway/gateway.ts';
import { BILLING_SOURCE, createUnifiedFixtures, DIRECTORY_SOURCE, postGraphQL } from '../fixtures/unified-sources.ts';

const TEAM_INVOICES = /* GraphQL */ `
  extend type Team {
    invoices: [Invoice]
      @resolveTo(
        sourceName: "billing"
        sourceTypeName: "Query"
        sourceFieldName: "teamInvoices"
        requiredSelectionSet: "{ slug }"
        sourceArgs: { slug: "{root.slug}" }
      )
  }
`;

let gateway: UnifiedGateway;

beforeAll(async () => {
  const fixtures = createUnifiedFixtures();
  const supergraph = await composeSupergraph([DIRECTORY_SOURCE, BILLING_SOURCE], {
    fetch: fixtures.fetch,
    additionalTypeDefs: TEAM_INVOICES,
  });
  gateway = createUnifiedGateway({ supergraph, fetch: fixtures.fetch });
});
afterAll(() => gateway.dispose());

describe('additionalTypeDefs with @resolveTo', () => {
  it('resolves Team.invoices from a second billing route', async () => {
    const body = await postGraphQL(gateway.runtime, '{ team(slug: "a") { name invoices { id amountCents } } }');
    expect(body.errors).toBeUndefined();
    expect(body.data?.team).toEqual({
      name: 'Team A',
      invoices: [
        { id: 'inv-2', amountCents: 4900 },
        { id: 'inv-1', amountCents: 4900 },
      ],
    });
  });

  it('refuses to extend a type no source has', async () => {
    const fixtures = createUnifiedFixtures();
    const composing = composeSupergraph([DIRECTORY_SOURCE], {
      fetch: fixtures.fetch,
      additionalTypeDefs: 'extend type Nope { x: String }',
    });
    await expect(composing).rejects.toBeInstanceOf(SupergraphCompositionError);
  });
});
