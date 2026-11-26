import { buildSchema, type GraphQLSchema, printType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { generateConceptSdl } from '../../server/concepts/generate.ts';
import { CONCEPT_SCHEMAS, teamConcept } from '../fixtures/concept-upstreams.ts';

/**
 * Prints one type of a schema, failing the test when it is missing.
 *
 * @param schema - The built schema.
 * @param name - The type's name.
 * @returns Its SDL.
 */
function typeSdl(schema: GraphQLSchema, name: string): string {
  const type = schema.getType(name);
  if (type === undefined || type === null) {
    throw new Error(`No type ${name} in the generated schema.`);
  }
  return printType(type);
}

describe('generateConceptSdl', () => {
  const schema = buildSchema(generateConceptSdl([teamConcept()], CONCEPT_SCHEMAS));

  it('keys the entity by an ID and takes the shared fields from the create variables', () => {
    expect(typeSdl(schema, 'TeamShared')).toContain('{\n  slug: String!\n  name: String!\n}');
    expect(typeSdl(schema, 'TeamSharedPatch')).toContain('{\n  slug: String\n  name: String\n}');
    expect(typeSdl(schema, 'Team')).toMatch(/id: ID!\n {2}slug: String\n {2}name: String\n/);
  });

  it("types a member's own input from its documents, copying upstream types under its prefix", () => {
    expect(typeSdl(schema, 'TeamBillingOwn')).toContain(
      'plan: TeamBilling_Plan!\n  limits: TeamBilling_LimitsInput\n}',
    );
    expect(typeSdl(schema, 'TeamBillingOwnPatch')).toContain('plan: TeamBilling_Plan\n}');
    expect(typeSdl(schema, 'TeamBilling_Plan')).toContain('FREE\n  PRO');
    expect(typeSdl(schema, 'TeamBilling_LimitsInput')).toContain('seats: Int!');
    expect(schema.getType('TeamDirectoryOwn')).toBeUndefined();
  });

  it('generates the app enum, presence, write result, query and mutations', () => {
    expect(typeSdl(schema, 'TeamApp')).toContain('DIRECTORY\n  BILLING');
    expect(typeSdl(schema, 'TeamPresence')).toContain(
      'app: TeamApp!\n  status: PresenceStatus!\n  drift: [FieldDrift!]!',
    );
    expect(typeSdl(schema, 'TeamWriteResult')).toMatch(/id: ID!\n {2}results: \[AppWriteResult!\]!/);
    const mutations = schema.getMutationType()?.getFields() ?? {};
    const signature = (name: string) => mutations[name]?.args.map((arg) => `${arg.name}: ${arg.type}`);
    const team = schema.getQueryType()?.getFields().team;
    expect(team?.type.toString()).toBe('Team');
    expect(team?.args.map((arg) => `${arg.name}: ${arg.type}`)).toEqual(['id: ID!']);
    expect(signature('createTeam')).toEqual([
      'id: ID',
      'shared: TeamShared!',
      'billing: TeamBillingOwn',
      'in: [TeamApp!]!',
    ]);
    expect(signature('updateTeam')).toEqual(['id: ID!', 'shared: TeamSharedPatch', 'billing: TeamBillingOwnPatch']);
    expect(signature('attachTeam')).toEqual(['id: ID!', 'app: TeamApp!', 'own: JSON']);
    expect(signature('deleteTeam')).toEqual(['id: ID!']);
  });

  it('composes several concepts into one schema without clashes', () => {
    const both = buildSchema(generateConceptSdl([teamConcept(), teamConcept('Squad')], CONCEPT_SCHEMAS));
    const mutations = Object.keys(both.getMutationType()?.getFields() ?? {});
    expect(mutations).toEqual([
      'createTeam',
      'updateTeam',
      'attachTeam',
      'deleteTeam',
      'createSquad',
      'updateSquad',
      'attachSquad',
      'deleteSquad',
    ]);
    expect(both.getType('SquadBilling_Plan')).toBeDefined();
    expect(both.getType('TeamBilling_Plan')).toBeDefined();
  });

  it('is still a schema with no concepts', () => {
    const empty = buildSchema(generateConceptSdl([], CONCEPT_SCHEMAS));
    expect(Object.keys(empty.getQueryType()?.getFields() ?? {})).toEqual(['concepts']);
    expect(empty.getMutationType()).toBeUndefined();
  });
});
