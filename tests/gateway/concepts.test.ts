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

/** The id the `core` team is created under, in every upstream. */
const CORE_ID = '6f1c4a52-3b8e-4d7a-9c21-5e0f8b3d2a14';

const CREATE = /* GraphQL */ `
  mutation ($id: ID, $shared: TeamShared!, $billing: TeamBillingOwn, $in: [TeamApp!]!) {
    createTeam(id: $id, shared: $shared, billing: $billing, in: $in) { id partial results { app ok } }
  }
`;

const READ = /* GraphQL */ `
  query ($id: ID!) {
    team(id: $id) { id slug name memberCount plan seats presence { app status drift { field actual } } }
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
      mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'team' }],
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
      mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'billingTeam' }],
    },
    {
      name: 'concepts',
      kind: 'schema',
      schema: createConceptSubgraph([concept], CONCEPT_SCHEMAS, upstreams.execute),
      renames: { fields: { 'Query.team': 'conceptTeam' } },
      mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'conceptTeam' }],
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
      id: CORE_ID,
      shared: { slug: 'core', name: 'Core' },
      billing: { plan: 'PRO' },
      in: ['DIRECTORY', 'BILLING'],
    });
    expect(body.errors).toBeUndefined();
    expect(body.data?.createTeam).toEqual({
      id: CORE_ID,
      partial: false,
      results: [
        { app: 'directory', ok: true },
        { app: 'billing', ok: true },
      ],
    });
  });

  it('reads one merged Team with fields from every source, presence included', async () => {
    const body = await postGraphQL(gateway.runtime, READ, { id: CORE_ID });
    expect(body.errors).toBeUndefined();
    expect(body.data?.team).toEqual({
      id: CORE_ID,
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
    const account = upstreams.accounts.get(CORE_ID);
    if (account === undefined) {
      throw new Error('The create test should have opened the account.');
    }
    account.displayName = 'Core (billing)';
    const body = await postGraphQL(gateway.runtime, READ, { id: CORE_ID });
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
      `mutation { updateTeam(id: "${CORE_ID}", shared: { name: "Core team" }) { partial } }`,
    );
    expect(update.errors).toBeUndefined();
    expect(update.data?.updateTeam).toEqual({ partial: false });
    expect(upstreams.teams.get(CORE_ID)?.name).toBe('Core team');
    expect(upstreams.accounts.get(CORE_ID)?.displayName).toBe('Core team');
  });

  it('refuses an id that is not a UUID before reaching any upstream', async () => {
    upstreams.calls.length = 0;
    const body = await postGraphQL(gateway.runtime, 'mutation { deleteTeam(id: "core") { partial } }');
    expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(upstreams.calls).toEqual([]);
  });
});
