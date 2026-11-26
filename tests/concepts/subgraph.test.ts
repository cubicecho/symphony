import { type GraphQLSchema, graphql } from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';
import { conceptSchema } from '../../server/concepts/concept.ts';
import { ConceptValidationError, createConceptSubgraph } from '../../server/concepts/subgraph.ts';
import { isUuid } from '../../server/concepts/uuid.ts';
import {
  CONCEPT_SCHEMAS,
  type ConceptUpstreams,
  createConceptUpstreams,
  teamConcept,
} from '../fixtures/concept-upstreams.ts';

/** The id the `core` team is created under. */
const CORE_ID = '6f1c4a52-3b8e-4d7a-9c21-5e0f8b3d2a14';

/** An id no upstream has. */
const NOBODY_ID = '00000000-0000-4000-8000-000000000000';

const CREATE = /* GraphQL */ `
  mutation ($id: ID, $shared: TeamShared!, $billing: TeamBillingOwn, $in: [TeamApp!]!) {
    createTeam(id: $id, shared: $shared, billing: $billing, in: $in) { id partial results { app ok error } }
  }
`;

const READ = /* GraphQL */ `
  query ($id: ID!) {
    team(id: $id) { id slug name presence { app status drift { field expected actual } error } }
  }
`;

const UPDATE = /* GraphQL */ `
  mutation ($id: ID!, $shared: TeamSharedPatch, $billing: TeamBillingOwnPatch) {
    updateTeam(id: $id, shared: $shared, billing: $billing) { id partial results { app ok error } }
  }
`;

const ATTACH = /* GraphQL */ `
  mutation ($id: ID!, $app: TeamApp!, $own: JSON) {
    attachTeam(id: $id, app: $app, own: $own) { id partial results { app ok error } }
  }
`;

const DELETE = 'mutation ($id: ID!) { deleteTeam(id: $id) { id partial results { app ok error } } }';

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
 * Creates the team `core` in both upstreams, under CORE_ID.
 *
 * @returns The createTeam payload.
 */
function createCore(): Promise<Record<string, unknown>> {
  return run(CREATE, {
    id: CORE_ID,
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
  it('creates in every chosen upstream, each with its own input shape, under one id', async () => {
    const data = await createCore();
    expect(data.createTeam).toEqual({
      id: CORE_ID,
      partial: false,
      results: [
        { app: 'directory', ok: true, error: null },
        { app: 'billing', ok: true, error: null },
      ],
    });
    expect(upstreams.teams.get(CORE_ID)).toEqual({ id: CORE_ID, slug: 'core', name: 'Core', memberCount: 0 });
    expect(upstreams.accounts.get(CORE_ID)).toEqual({
      id: CORE_ID,
      handle: 'core',
      displayName: 'Core',
      plan: 'PRO',
      seats: null,
    });
  });

  it('mints a UUID when no id is given, and gives every upstream the same one', async () => {
    const data = await run(CREATE, {
      shared: { slug: 'core', name: 'Core' },
      billing: { plan: 'PRO' },
      in: ['DIRECTORY', 'BILLING'],
    });
    const { id } = data.createTeam as { id: unknown };
    expect(isUuid(id)).toBe(true);
    expect(id).toBe(String(id).toLowerCase());
    expect([...upstreams.teams.keys()]).toEqual([id]);
    expect([...upstreams.accounts.keys()]).toEqual([id]);
  });

  it("accepts the caller's UUID in any case, and stores it lower-cased", async () => {
    const data = await run(CREATE, {
      id: CORE_ID.toUpperCase(),
      shared: { slug: 'core', name: 'Core' },
      in: ['DIRECTORY'],
    });
    expect(data.createTeam).toMatchObject({ id: CORE_ID, partial: false });
    expect([...upstreams.teams.keys()]).toEqual([CORE_ID]);
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
    expect(upstreams.teams.has(CORE_ID)).toBe(true);
  });

  it('fails a member whose required own fields are missing, without calling it', async () => {
    const data = await run(CREATE, { id: CORE_ID, shared: { slug: 'core', name: 'Core' }, in: ['BILLING'] });
    expect(data.createTeam).toMatchObject({
      partial: true,
      results: [{ app: 'billing', ok: false, error: 'create needs $plan.' }],
    });
    expect(upstreams.calls).toEqual([]);
  });
});

describe('ids that are not UUIDs', () => {
  const NOT_A_UUID = 'core';
  const operations: [string, string, Record<string, unknown>][] = [
    ['create', CREATE, { id: NOT_A_UUID, shared: { slug: 'core', name: 'Core' }, in: ['DIRECTORY'] }],
    ['query', READ, { id: NOT_A_UUID }],
    ['update', UPDATE, { id: NOT_A_UUID, shared: { name: 'Core' } }],
    ['attach', ATTACH, { id: NOT_A_UUID, app: 'BILLING', own: { plan: 'PRO' } }],
    ['delete', DELETE, { id: NOT_A_UUID }],
  ];

  it.each(operations)('are refused on %s before any upstream is called', async (_name, source, variableValues) => {
    const result = await graphql({ schema, source, variableValues });
    expect(result.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
    expect(result.errors?.[0]?.message).toMatch(/^"core" is not a UUID/);
    expect(upstreams.calls).toEqual([]);
  });
});

describe('update', () => {
  it('writes a shared field to every member', async () => {
    await createCore();
    const data = await run(UPDATE, { id: CORE_ID, shared: { name: 'Core Platform' } });
    expect(data.updateTeam).toMatchObject({
      id: CORE_ID,
      partial: false,
      results: [{ app: 'directory' }, { app: 'billing' }],
    });
    expect(upstreams.teams.get(CORE_ID)?.name).toBe('Core Platform');
    expect(upstreams.accounts.get(CORE_ID)?.displayName).toBe('Core Platform');
  });

  it('writes an owned field to its owner only', async () => {
    await createCore();
    upstreams.calls.length = 0;
    const data = await run(UPDATE, { id: CORE_ID, billing: { plan: 'FREE' } });
    expect(data.updateTeam).toEqual({
      id: CORE_ID,
      partial: false,
      results: [{ app: 'billing', ok: true, error: null }],
    });
    expect(upstreams.calls.map((call) => call.upstream)).toEqual(['billing']);
    expect(upstreams.accounts.get(CORE_ID)).toMatchObject({ plan: 'FREE', displayName: 'Core' });
  });

  it('refuses a patch that changes nothing', async () => {
    const result = await graphql({ schema, source: UPDATE, variableValues: { id: CORE_ID } });
    expect(result.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('attach', () => {
  it('creates the entity in one more upstream under the same id, copying its shared fields', async () => {
    await run(CREATE, { id: CORE_ID, shared: { slug: 'core', name: 'Core' }, in: ['DIRECTORY'] });
    const data = await run(ATTACH, { id: CORE_ID, app: 'BILLING', own: { plan: 'PRO', limits: { seats: 5 } } });
    expect(data.attachTeam).toEqual({
      id: CORE_ID,
      partial: false,
      results: [{ app: 'billing', ok: true, error: null }],
    });
    expect(upstreams.accounts.get(CORE_ID)).toEqual({
      id: CORE_ID,
      handle: 'core',
      displayName: 'Core',
      plan: 'PRO',
      seats: 5,
    });
  });

  it('refuses a field the upstream does not own, and an id no upstream has', async () => {
    const foreign = await graphql({
      schema,
      source: ATTACH,
      variableValues: { id: CORE_ID, app: 'BILLING', own: { colour: 'red' } },
    });
    expect(foreign.errors?.[0]?.extensions.code).toBe('BAD_USER_INPUT');
    const unknown = await graphql({
      schema,
      source: ATTACH,
      variableValues: { id: CORE_ID, app: 'BILLING', own: { plan: 'PRO' } },
    });
    expect(unknown.errors?.[0]?.extensions.code).toBe('NOT_FOUND');
  });
});

describe('delete', () => {
  it('deletes everywhere, and deleting again is not an error', async () => {
    await createCore();
    const everywhere = {
      id: CORE_ID,
      partial: false,
      results: [
        { app: 'directory', ok: true, error: null },
        { app: 'billing', ok: true, error: null },
      ],
    };
    expect((await run(DELETE, { id: CORE_ID })).deleteTeam).toEqual(everywhere);
    expect(upstreams.teams.size + upstreams.accounts.size).toBe(0);
    // directory's removeTeam now fails with "No team …"; its fetch then finds nothing, which counts as done.
    expect((await run(DELETE, { id: CORE_ID })).deleteTeam).toEqual(everywhere);
  });

  it('fails a member whose delete fails while the entity is still there', async () => {
    await createCore();
    upstreams.unreachable.add('billing');
    const data = await run(DELETE, { id: CORE_ID });
    expect(data.deleteTeam).toMatchObject({
      partial: true,
      results: [{ ok: true }, { app: 'billing', ok: false, error: 'Could not reach billing.' }],
    });
  });
});

describe('read', () => {
  it('reads the entity from every upstream', async () => {
    await createCore();
    const data = await run(READ, { id: CORE_ID });
    expect(data.team).toEqual({
      id: CORE_ID,
      slug: 'core',
      name: 'Core',
      presence: [
        { app: 'DIRECTORY', status: 'PRESENT', drift: [], error: null },
        { app: 'BILLING', status: 'PRESENT', drift: [], error: null },
      ],
    });
  });

  it('reads an id sent in upper case', async () => {
    await createCore();
    const data = await run(READ, { id: CORE_ID.toUpperCase() });
    expect(data.team).toMatchObject({ id: CORE_ID, slug: 'core' });
  });

  it('shows drift, a missing member and an unreachable one', async () => {
    await createCore();
    const account = upstreams.accounts.get(CORE_ID);
    if (account !== undefined) {
      account.displayName = 'Core (old)';
    }
    const drifted = await run(READ, { id: CORE_ID });
    expect(drifted.team).toMatchObject({
      name: 'Core',
      presence: [
        { app: 'DIRECTORY', status: 'PRESENT' },
        { app: 'BILLING', status: 'DRIFTED', drift: [{ field: 'name', expected: 'Core', actual: 'Core (old)' }] },
      ],
    });
    upstreams.teams.delete(CORE_ID);
    upstreams.unreachable.add('billing');
    const partial = await run(READ, { id: CORE_ID });
    expect(partial.team).toMatchObject({
      id: CORE_ID,
      name: null,
      presence: [
        { app: 'DIRECTORY', status: 'MISSING', drift: [] },
        { app: 'BILLING', status: 'ERROR', error: 'Could not reach billing.' },
      ],
    });
  });

  it('is null when no upstream has the id', async () => {
    expect((await run(READ, { id: NOBODY_ID })).team).toBeNull();
  });
});
