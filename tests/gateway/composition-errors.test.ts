// Question 6: what a failed composition gives back, and that a failed recompose leaves the gateway serving.
import { composeSupergraph, SupergraphCompositionError } from '../../server/gateway/compose.ts';
import { createUnifiedGateway } from '../../server/gateway/gateway.ts';
import type { Source } from '../../server/gateway/sources.ts';
import { BILLING_SOURCE, createUnifiedFixtures, DIRECTORY_SOURCE, postGraphQL } from '../fixtures/unified-sources.ts';

/**
 * Composes and returns the error it fails with.
 *
 * @param sources - Sources that should not compose.
 * @param [fetchFn] - Answers the sources' requests; the fixtures by default.
 * @returns The composition error.
 */
async function compositionError(
  sources: Source[],
  fetchFn = createUnifiedFixtures().fetch,
): Promise<SupergraphCompositionError> {
  const error = await composeSupergraph(sources, { fetch: fetchFn }).catch((caught: unknown) => caught);
  if (error instanceof SupergraphCompositionError) {
    return error;
  }
  throw new Error(`Expected a SupergraphCompositionError, got ${String(error)}.`);
}

// Both sources keep their own `members` (a list in one, a count in the other) under the same name.
const directoryWithoutFieldRenames: Source = {
  ...DIRECTORY_SOURCE,
  renames: { types: { DirectoryTeam: 'Team' }, fields: { 'Query.directoryTeam': 'team' } },
};
const billingWithoutFieldRenames: Source = { ...BILLING_SOURCE, renames: { types: { BillingTeam: 'Team' } } };

describe('composition errors', () => {
  it('reports an un-renamed clashing field as coded issues', async () => {
    const error = await compositionError([directoryWithoutFieldRenames, billingWithoutFieldRenames]);
    const codes = error.issues.map((issue) => issue.code);
    expect(codes).toContain('FIELD_TYPE_MISMATCH');
    expect(error.issues.find((issue) => issue.code === 'FIELD_TYPE_MISMATCH')?.message).toContain('Team.members');
  });

  it('reports a merge key on a type the source does not have', async () => {
    const error = await compositionError([
      DIRECTORY_SOURCE,
      { ...BILLING_SOURCE, mergeKeys: [{ type: 'Nope', keyField: 'slug', lookupField: 'billingTeam' }] },
    ]);
    expect(error.issues).toEqual([expect.objectContaining({ code: 'TRANSFORM_FAILED', source: 'billing' })]);
  });

  it('reports a source that fails to load, by name', async () => {
    const unreachable: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const error = await compositionError([BILLING_SOURCE], unreachable);
    expect(error.issues).toEqual([expect.objectContaining({ code: 'SOURCE_LOAD_FAILED', source: 'billing' })]);
  });

  it('keeps serving the last good supergraph when a recompose fails', async () => {
    const fixtures = createUnifiedFixtures();
    const supergraph = await composeSupergraph([DIRECTORY_SOURCE], { fetch: fixtures.fetch });
    const gateway = createUnifiedGateway({ supergraph, fetch: fixtures.fetch });
    await expect(gateway.recompose([directoryWithoutFieldRenames, billingWithoutFieldRenames])).rejects.toBeInstanceOf(
      SupergraphCompositionError,
    );
    const body = await postGraphQL(gateway.runtime, '{ team(slug: "a") { name } }');
    expect(body.data?.team).toEqual({ name: 'Team A' });
    await gateway.dispose();
  });
});
