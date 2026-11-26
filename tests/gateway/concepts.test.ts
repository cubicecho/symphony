// The two spike tracks together: a concept subgraph generated from concept rows, served in-process by the unified
// gateway beside the upstreams it writes to, so one endpoint reads the merged entity and writes it everywhere.
import { conceptSchema } from '../../server/concepts/concept.ts';
import { createConceptSubgraph } from '../../server/concepts/subgraph.ts';
import { composeSupergraph } from '../../server/gateway/compose.ts';
import { createUnifiedGateway, type UnifiedGateway } from '../../server/gateway/gateway.ts';
import type { Source } from '../../server/gateway/sources.ts';
import {
  BILLING_SDL,
  CONCEPT_SCHEMAS,
  type ConceptUpstreams,
  conceptUpstreamUrl,
  createConceptUpstreams,
  DIRECTORY_SDL,
  teamConcept,
} from '../fixtures/concept-upstreams.ts';
import { postGraphQL } from '../fixtures/unified-sources.ts';

const CREATE = /* GraphQL */ `
  mutation ($shared: TeamShared!, $billing: TeamBillingOwn, $in: [TeamApp!]!) {
    createTeam(shared: $shared, billing: $billing, in: $in) { key partial results { app ok } }
  }
`;

const READ = /* GraphQL */ `
  query ($slug: String!) {
    team(slug: $slug) { slug name memberCount plan seats presence { app status drift { field actual } } }
  }
`;

let upstreams: ConceptUpstreams;
let gateway: UnifiedGateway;

/**
 * Describes the fixture upstreams and the generated concept subgraph as gateway sources, all merging into `Team`.
 *
 * @returns The sources.
 */
function sources(): Source[] {
  const concept = conceptSchema.parse(teamConcept());
  return [
    {
      name: 'directory',
      kind: 'graphql',
      endpoint: conceptUpstreamUrl('directory'),
      sdl: DIRECTORY_SDL,
      mergeKeys: [{ type: 'Team', keyField: 'slug', lookupField: 'team' }],
    },
    {
      name: 'billing',
      kind: 'graphql',
      endpoint: conceptUpstreamUrl('billing'),
      sdl: BILLING_SDL,
      renames: {
        types: { Account: 'Team' },
        fields: { 'Account.handle': 'slug', 'Account.displayName': 'name', 'Query.account': 'billingTeam' },
      },
      mergeKeys: [{ type: 'Team', keyField: 'slug', lookupField: 'billingTeam', keyArg: 'handle' }],
    },
    {
      name: 'concepts',
      kind: 'schema',
      schema: createConceptSubgraph([concept], CONCEPT_SCHEMAS, upstreams.execute),
      renames: { fields: { 'Query.team': 'conceptTeam' } },
      mergeKeys: [{ type: 'Team', keyField: 'slug', lookupField: 'conceptTeam', keyArg: 'key' }],
    },
  ];
}

beforeAll(async () => {
  upstreams = createConceptUpstreams();
  const supergraph = await composeSupergraph(sources(), { fetch: upstreams.fetch });
  gateway = createUnifiedGateway({ supergraph, fetch: upstreams.fetch });
});
afterAll(() => gateway.dispose());

describe('a generated concept subgraph behind the unified gateway', () => {
  it('creates the entity in every upstream through one mutation', async () => {
    const body = await postGraphQL(gateway.runtime, CREATE, {
      shared: { slug: 'core', name: 'Core' },
      billing: { plan: 'PRO' },
      in: ['DIRECTORY', 'BILLING'],
    });
    expect(body.errors).toBeUndefined();
    expect(body.data?.createTeam).toEqual({
      key: 'core',
      partial: false,
      results: [
        { app: 'directory', ok: true },
        { app: 'billing', ok: true },
      ],
    });
  });

  it('reads one merged Team with fields from every source, presence included', async () => {
    const body = await postGraphQL(gateway.runtime, READ, { slug: 'core' });
    expect(body.errors).toBeUndefined();
    expect(body.data?.team).toEqual({
      slug: 'core',
      name: 'Core',
      memberCount: 0,
      plan: 'PRO',
      seats: null,
      presence: [
        { app: 'DIRECTORY', status: 'PRESENT', drift: [] },
        { app: 'BILLING', status: 'PRESENT', drift: [] },
      ],
    });
  });

  it('shows drift when one upstream is changed behind the gateway', async () => {
    const account = upstreams.accounts.get('core');
    if (account === undefined) {
      throw new Error('The create test should have opened the account.');
    }
    account.displayName = 'Core (billing)';
    const body = await postGraphQL(gateway.runtime, READ, { slug: 'core' });
    expect(body.errors).toBeUndefined();
    const team = body.data?.team as { presence: unknown[] };
    expect(team.presence).toEqual([
      { app: 'DIRECTORY', status: 'PRESENT', drift: [] },
      { app: 'BILLING', status: 'DRIFTED', drift: [{ field: 'name', actual: 'Core (billing)' }] },
    ]);
  });

  it('repairs the drift with one update, written to every upstream', async () => {
    const update = await postGraphQL(
      gateway.runtime,
      'mutation { updateTeam(key: "core", shared: { name: "Core team" }) { partial } }',
    );
    expect(update.errors).toBeUndefined();
    expect(update.data?.updateTeam).toEqual({ partial: false });
    expect(upstreams.teams.get('core')?.name).toBe('Core team');
    expect(upstreams.accounts.get('core')?.displayName).toBe('Core team');
  });
});
