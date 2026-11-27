// Field conflicts: a field of a merged type that several sources provide is found once renames apply, served from
// one source (the concept's priority, or the definition's default), and warned about when nothing settles it.
import { buildSchema, type GraphQLSchema } from 'graphql';
import { type Concept, conceptSchema } from '../../server/concepts/concept.ts';
import { generateConceptSdl } from '../../server/concepts/generate.ts';
import { createConceptSubgraph } from '../../server/concepts/subgraph.ts';
import { composeSupergraph } from '../../server/gateway/compose.ts';
import {
  type ConflictSource,
  type FieldConflict,
  findFieldConflicts,
  hiddenFieldsOf,
  isWarned,
  priorityProblems,
} from '../../server/gateway/field-conflicts.ts';
import { createUnifiedGateway } from '../../server/gateway/gateway.ts';
import type { Source } from '../../server/gateway/sources.ts';
import {
  applyWiringOverrides,
  CONCEPT_SOURCE_NAME,
  deriveWiring,
  type EffectiveWiring,
  sourceWiringFields,
  type WiringOverride,
} from '../../server/gateway/wiring.ts';
import {
  BILLING_SDL,
  CONCEPT_SCHEMAS,
  conceptUpstreamUrl,
  createConceptUpstreams,
  DIRECTORY_SDL,
  teamConcept,
} from '../fixtures/concept-upstreams.ts';
import { postGraphQL } from '../fixtures/unified-sources.ts';

/** The team both upstreams hold, under different names. */
const CORE_ID = '6f1c4a52-3b8e-4d7a-9c21-5e0f8b3d2a14';

/** Billing's seats, renamed onto the directory's memberCount: two members then give Team the same field. */
const SEATS_AS_MEMBER_COUNT: WiringOverride = {
  upstream: 'billing',
  renames: { fields: { 'Account.seats': 'memberCount' } },
};

/**
 * Reads a fixture upstream's schema.
 *
 * @param upstream - Its name.
 * @returns The schema.
 */
function schemaOf(upstream: string): GraphQLSchema {
  const schema = CONCEPT_SCHEMAS.get(upstream);
  if (schema === undefined) {
    throw new Error(`No fixture schema for ${upstream}.`);
  }
  return schema;
}

/**
 * Wires the Team concept as the unified service would, and finds its field conflicts.
 *
 * @param concept - The concept.
 * @param [overrides] - Wiring overrides.
 * @returns The effective wiring and the conflicts.
 */
function wire(concept: Concept, overrides: WiringOverride[] = []) {
  const derived = deriveWiring([concept], CONCEPT_SCHEMAS);
  expect(derived.problems).toEqual([]);
  const wiring = applyWiringOverrides(derived.wiring, overrides);
  const wiringOf = (name: string) => wiring.find((one) => one.upstream === name);
  const sources: ConflictSource[] = [
    { name: 'directory', schema: schemaOf('directory'), wiring: wiringOf('directory') },
    { name: 'billing', schema: schemaOf('billing'), wiring: wiringOf('billing') },
    {
      name: CONCEPT_SOURCE_NAME,
      schema: buildSchema(generateConceptSdl([concept], CONCEPT_SCHEMAS)),
      wiring: wiringOf(CONCEPT_SOURCE_NAME),
    },
  ];
  return { wiring, conflicts: findFieldConflicts([concept], sources) };
}

/**
 * Picks the parts of a conflict a test compares.
 *
 * @param conflict - A conflict.
 * @returns Its field, sources, priority, server and resolution.
 */
function summary(conflict: FieldConflict) {
  const { field, sources, priority, servedBy, resolution } = conflict;
  return { field, sources, priority, servedBy, resolution };
}

describe('findFieldConflicts', () => {
  it('serves shared fields from the concept subgraph by default, without warning', () => {
    const { conflicts } = wire(conceptSchema.parse(teamConcept()));
    const everyone = ['billing', 'directory', CONCEPT_SOURCE_NAME];
    expect(conflicts.map(summary)).toEqual([
      { field: 'name', sources: everyone, priority: null, servedBy: CONCEPT_SOURCE_NAME, resolution: 'shared' },
      { field: 'slug', sources: everyone, priority: null, servedBy: CONCEPT_SOURCE_NAME, resolution: 'shared' },
    ]);
    expect(conflicts.filter(isWarned)).toEqual([]);
  });

  it('warns about a field two members provide that nothing settles', () => {
    const { conflicts } = wire(conceptSchema.parse(teamConcept()), [SEATS_AS_MEMBER_COUNT]);
    const warned = conflicts.filter(isWarned);
    expect(warned.map(summary)).toEqual([
      { field: 'memberCount', sources: ['billing', 'directory'], priority: null, servedBy: null, resolution: null },
    ]);
    expect(warned[0]).toMatchObject({ concept: 'Team', type: 'Team' });
    expect(warned[0]?.message).toMatch(/Set priority\.memberCount in the Team concept/);
    expect(hiddenFieldsOf(conflicts, 'billing')).toEqual({ Team: ['name', 'slug'] });
  });

  it('serves a prioritized field from that member alone, and warns about it as resolved', () => {
    const concept = conceptSchema.parse({ ...teamConcept(), priority: { name: 'billing', memberCount: 'directory' } });
    const { conflicts } = wire(concept, [SEATS_AS_MEMBER_COUNT]);
    expect(conflicts.filter(isWarned).map(summary)).toEqual([
      {
        field: 'memberCount',
        sources: ['billing', 'directory'],
        priority: 'directory',
        servedBy: 'directory',
        resolution: 'priority',
      },
      {
        field: 'name',
        sources: ['billing', 'directory', CONCEPT_SOURCE_NAME],
        priority: 'billing',
        servedBy: 'billing',
        resolution: 'priority',
      },
    ]);
    expect(hiddenFieldsOf(conflicts, 'billing')).toEqual({ Team: ['memberCount', 'slug'] });
    expect(hiddenFieldsOf(conflicts, 'directory')).toEqual({ Team: ['name', 'slug'] });
    expect(hiddenFieldsOf(conflicts, CONCEPT_SOURCE_NAME)).toEqual({ Team: ['name'] });
  });
});

describe('priority validation', () => {
  it('refuses a priority for the id or presence, or for an app that is not a member', () => {
    const definition = { ...teamConcept(), priority: { id: 'billing', presence: 'billing', name: 'payroll' } };
    const messages = conceptSchema.safeParse(definition).error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual([
      'priority.id: "id" is the merge key, which every source serves, so no member can be picked for it.',
      'priority.presence: "presence" is served by the concept subgraph alone, so no member can be picked for it.',
      'priority.name: "payroll" is not a member. The members: directory, billing.',
    ]);
  });

  it('refuses a member that does not provide the field, as its fetch renames it', () => {
    const concept = conceptSchema.parse({ ...teamConcept(), priority: { memberCount: 'billing', name: 'billing' } });
    expect(priorityProblems(concept, CONCEPT_SCHEMAS)).toEqual([
      {
        concept: 'Team',
        member: 'billing',
        operation: null,
        message:
          'priority.memberCount: billing gives Team no field "memberCount"; it gives id, name, plan, seats, slug.',
        line: null,
        column: null,
      },
    ]);
  });
});

describe('a priority through the gateway', () => {
  const READ = `{ team(id: "${CORE_ID}") { name slug } directoryTeam(id: "${CORE_ID}") { name } }`;

  /**
   * Serves the concept and its members behind the gateway, each source hiding what another serves.
   *
   * @param concept - The concept.
   * @returns The gateway, with the core team stored under a different name in each upstream.
   */
  async function serve(concept: Concept) {
    const upstreams = createConceptUpstreams();
    upstreams.teams.set(CORE_ID, { id: CORE_ID, slug: 'core', name: 'Core (directory)', memberCount: 3 });
    upstreams.accounts.set(CORE_ID, {
      id: CORE_ID,
      handle: 'core',
      displayName: 'Core (billing)',
      plan: 'PRO',
      seats: null,
    });
    const { wiring, conflicts } = wire(concept);
    const wiringOf = (name: string): EffectiveWiring => {
      const found = wiring.find((one) => one.upstream === name);
      if (found === undefined) {
        throw new Error(`No wiring for ${name}.`);
      }
      return found;
    };
    const member = (name: string, sdl: string): Source => ({
      name,
      kind: 'graphql',
      endpoint: conceptUpstreamUrl(name),
      sdl,
      hiddenFields: hiddenFieldsOf(conflicts, name),
      ...sourceWiringFields(wiringOf(name)),
    });
    const sources: Source[] = [
      member('directory', DIRECTORY_SDL),
      member('billing', BILLING_SDL),
      {
        name: CONCEPT_SOURCE_NAME,
        kind: 'schema',
        schema: createConceptSubgraph([concept], CONCEPT_SCHEMAS, upstreams.execute),
        hiddenFields: hiddenFieldsOf(conflicts, CONCEPT_SOURCE_NAME),
        ...sourceWiringFields(wiringOf(CONCEPT_SOURCE_NAME)),
      },
    ];
    const supergraph = await composeSupergraph(sources, { fetch: upstreams.fetch });
    return createUnifiedGateway({ supergraph, fetch: upstreams.fetch });
  }

  it('reads a shared field from the first member that has it when no priority is set', async () => {
    const gateway = await serve(conceptSchema.parse(teamConcept()));
    const body = await postGraphQL(gateway.runtime, READ);
    await gateway.dispose();
    expect(body).toEqual({
      data: { team: { name: 'Core (directory)', slug: 'core' }, directoryTeam: { name: 'Core (directory)' } },
    });
  });

  it('reads it from the prioritized member, whichever root the query starts from', async () => {
    const gateway = await serve(conceptSchema.parse({ ...teamConcept(), priority: { name: 'billing' } }));
    const body = await postGraphQL(gateway.runtime, READ);
    await gateway.dispose();
    expect(body).toEqual({
      data: { team: { name: 'Core (billing)', slug: 'core' }, directoryTeam: { name: 'Core (billing)' } },
    });
  });
});
