import { type GraphQLSchema, graphql } from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';
import { conceptSchema } from '../../server/concepts/concept.ts';
import { ConceptValidationError, createConceptSubgraph } from '../../server/concepts/subgraph.ts';
import {
  CONCEPT_SCHEMAS,
  type ConceptUpstreams,
  createConceptUpstreams,
  teamConcept,
} from '../fixtures/concept-upstreams.ts';

const CREATE = /* GraphQL */ `
  mutation ($shared: TeamShared!, $billing: TeamBillingOwn, $in: [TeamApp!]!) {
    createTeam(shared: $shared, billing: $billing, in: $in) { key partial results { app ok error } }
  }
`;

const READ = /* GraphQL */ `
  query ($key: String!) {
    team(key: $key) { slug name presence { app status drift { field expected actual } error } }
  }
`;

let upstreams: ConceptUpstreams;
let schema: GraphQLSchema;

/**
 * Runs an operation against the concept subgraph, failing on GraphQL errors.
 *
 * @param source - The document.
 * @param [variables] - Its variables.
 * @returns The data.
 */
async function run(source: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await graphql({ schema, source, variableValues: variables });
  expect(result.errors).toBeUndefined();
  return result.data ?? {};
}

/**
 * Creates the team `core` in both upstreams.
 *
 * @returns The createTeam payload.
 */
function createCore(): Promise<Record<string, unknown>> {
  return run(CREATE, {
    shared: { slug: 'core', name: 'Core' },
    billing: { plan: 'PRO' },
    in: ['DIRECTORY', 'BILLING'],
  });
}

beforeEach(() => {
  upstreams = createConceptUpstreams();
  schema = createConceptSubgraph([conceptSchema.parse(teamConcept())], CONCEPT_SCHEMAS, upstreams.execute);
});

describe('createConceptSubgraph', () => {
  it('refuses concepts whose documents do not fit, listing the problems', () => {
    const concept = teamConcept();
    const broken = { ...concept, members: [{ ...concept.members[0], upstream: 'nowhere' }, concept.members[1]] };
    const build = () => createConceptSubgraph([conceptSchema.parse(broken)], CONCEPT_SCHEMAS, upstreams.execute);
    expect(build).toThrow(ConceptValidationError);
    expect(build).toThrow(/Team \/ nowhere: There is no schema for the upstream "nowhere"/);
  });
});

describe('create', () => {
  it('creates in every chosen upstream, each with its own input shape', async () => {
    const data = await createCore();
    expect(data.createTeam).toEqual({
      key: 'core',
      partial: false,
      results: [
        { app: 'directory', ok: true, error: null },
        { app: 'billing', ok: true, error: null },
      ],
    });
    expect(upstreams.teams.get('core')).toEqual({ slug: 'core', name: 'Core', memberCount: 0 });
    expect(upstreams.accounts.get('core')).toEqual({ handle: 'core', displayName: 'Core', plan: 'PRO', seats: null });
  });

  it('reports a partial create when one upstream fails, and keeps what the other wrote', async () => {
    upstreams.billingRefusesOpen = true;
    const data = await createCore();
    expect(data.createTeam).toMatchObject({
      partial: true,
      results: [
        { app: 'directory', ok: true },
        { app: 'billing', ok: false, error: 'Billing is closed for new accounts.' },
      ],
    });
    expect(upstreams.teams.has('core')).toBe(true);
  });

  it('fails a member whose required own fields are missing, without calling it', async () => {
    const data = await run(CREATE, { shared: { slug: 'core', name: 'Core' }, in: ['BILLING'] });
    expect(data.createTeam).toMatchObject({
      partial: true,
      results: [{ app: 'billing', ok: false, error: 'create needs $plan.' }],
    });
    expect(upstreams.calls).toEqual([]);
  });
});

describe('update', () => {
  const UPDATE = /* GraphQL */ `
    mutation ($key: String!, $shared: TeamSharedPatch, $billing: TeamBillingOwnPatch) {
      updateTeam(key: $key, shared: $shared, billing: $billing) { partial results { app ok error } }
    }
  `;

  it('writes a shared field to every member', async () => {
    await createCore();
    const data = await run(UPDATE, { key: 'core', shared: { name: 'Core Platform' } });
    expect(data.updateTeam).toMatchObject({ partial: false, results: [{ app: 'directory' }, { app: 'billing' }] });
    expect(upstreams.teams.get('core')?.name).toBe('Core Platform');
    expect(upstreams.accounts.get('core')?.displayName).toBe('Core Platform');
  });

  it('writes an owned field to its owner only', async () => {
    await createCore();
    upstreams.calls.length = 0;
    const data = await run(UPDATE, { key: 'core', billing: { plan: 'FREE' } });
    expect(data.updateTeam).toEqual({ partial: false, results: [{ app: 'billing', ok: true, error: null }] });
    expect(upstreams.calls.map((call) => call.upstream)).toEqual(['billing']);
    expect(upstreams.accounts.get('core')).toMatchObject({ plan: 'FREE', displayName: 'Core' });
  });

  it('refuses a patch that changes nothing', async () => {
    const result = await graphql({ schema, source: UPDATE, variableValues: { key: 'core' } });
    expect(result.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('attach', () => {
  const ATTACH = /* GraphQL */ `
    mutation ($key: String!, $app: TeamApp!, $own: JSON) {
      attachTeam(key: $key, app: $app, own: $own) { partial results { app ok error } }
    }
  `;

  it('creates the entity in one more upstream, copying its shared fields', async () => {
    await run(CREATE, { shared: { slug: 'core', name: 'Core' }, in: ['DIRECTORY'] });
    const data = await run(ATTACH, { key: 'core', app: 'BILLING', own: { plan: 'PRO', limits: { seats: 5 } } });
    expect(data.attachTeam).toEqual({ partial: false, results: [{ app: 'billing', ok: true, error: null }] });
    expect(upstreams.accounts.get('core')).toEqual({ handle: 'core', displayName: 'Core', plan: 'PRO', seats: 5 });
  });

  it('refuses a field the upstream does not own, and a key no upstream has', async () => {
    const foreign = await graphql({
      schema,
      source: ATTACH,
      variableValues: { key: 'core', app: 'BILLING', own: { colour: 'red' } },
    });
    expect(foreign.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
    const unknown = await graphql({
      schema,
      source: ATTACH,
      variableValues: { key: 'core', app: 'BILLING', own: { plan: 'PRO' } },
    });
    expect(unknown.errors?.[0]?.extensions.code).toBe('NOT_FOUND');
  });
});

describe('delete', () => {
  const DELETE = 'mutation ($key: String!) { deleteTeam(key: $key) { partial results { app ok error } } }';

  it('deletes everywhere, and deleting again is not an error', async () => {
    await createCore();
    const everywhere = {
      partial: false,
      results: [
        { app: 'directory', ok: true, error: null },
        { app: 'billing', ok: true, error: null },
      ],
    };
    expect((await run(DELETE, { key: 'core' })).deleteTeam).toEqual(everywhere);
    expect(upstreams.teams.size + upstreams.accounts.size).toBe(0);
    // directory's removeTeam now fails with "No team core."; its fetch then finds nothing, which counts as done.
    expect((await run(DELETE, { key: 'core' })).deleteTeam).toEqual(everywhere);
  });

  it('fails a member whose delete fails while the entity is still there', async () => {
    await createCore();
    upstreams.unreachable.add('billing');
    const data = await run(DELETE, { key: 'core' });
    expect(data.deleteTeam).toMatchObject({
      partial: true,
      results: [{ ok: true }, { app: 'billing', ok: false, error: 'Could not reach billing.' }],
    });
  });
});

describe('read', () => {
  it('reads the entity from every upstream', async () => {
    await createCore();
    const data = await run(READ, { key: 'core' });
    expect(data.team).toEqual({
      slug: 'core',
      name: 'Core',
      presence: [
        { app: 'DIRECTORY', status: 'PRESENT', drift: [], error: null },
        { app: 'BILLING', status: 'PRESENT', drift: [], error: null },
      ],
    });
  });

  it('shows drift, a missing member and an unreachable one', async () => {
    await createCore();
    const account = upstreams.accounts.get('core');
    if (account !== undefined) {
      account.displayName = 'Core (old)';
    }
    const drifted = await run(READ, { key: 'core' });
    expect(drifted.team).toMatchObject({
      name: 'Core',
      presence: [
        { app: 'DIRECTORY', status: 'PRESENT' },
        { app: 'BILLING', status: 'DRIFTED', drift: [{ field: 'name', expected: 'Core', actual: 'Core (old)' }] },
      ],
    });
    upstreams.teams.delete('core');
    upstreams.unreachable.add('billing');
    const partial = await run(READ, { key: 'core' });
    expect(partial.team).toMatchObject({
      name: null,
      presence: [
        { app: 'DIRECTORY', status: 'MISSING', drift: [] },
        { app: 'BILLING', status: 'ERROR', error: 'Could not reach billing.' },
      ],
    });
  });

  it('is null when no upstream has the key', async () => {
    expect((await run(READ, { key: 'nobody' })).team).toBeNull();
  });
});
