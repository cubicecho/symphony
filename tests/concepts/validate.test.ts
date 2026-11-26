import { describe, expect, it } from 'vitest';
import { type Concept, conceptSchema } from '../../server/concepts/concept.ts';
import { validateConcept, validateConcepts } from '../../server/concepts/validate.ts';
import { CONCEPT_SCHEMAS, teamConcept } from '../fixtures/concept-upstreams.ts';

/**
 * Replaces one member document of the Team concept.
 *
 * @param upstream - The member.
 * @param operation - Which document.
 * @param text - The new document.
 * @returns The changed concept.
 */
function withDocument(upstream: string, operation: 'fetch' | 'create' | 'update' | 'delete', text: string): Concept {
  const concept = teamConcept();
  return {
    ...concept,
    members: concept.members.map((member) =>
      member.upstream === upstream ? { ...member, documents: { ...member.documents, [operation]: text } } : member,
    ),
  };
}

describe('conceptSchema', () => {
  it('accepts the fixture concept', () => {
    expect(conceptSchema.safeParse(teamConcept()).success).toBe(true);
  });

  it('refuses a field called id, a foreign owner and a repeated member', () => {
    const concept = teamConcept();
    const broken = {
      ...concept,
      fields: [...concept.fields, { name: 'id', mode: 'shared' }, { name: 'tax', mode: 'owned', owner: 'payroll' }],
      members: [...concept.members, concept.members[0]],
    };
    const result = conceptSchema.safeParse(broken);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual([
      'The upstream "directory" is listed as a member more than once.',
      'No field may be called "id": every concept has it already, as the entity\'s Symphony UUID.',
      'The field "tax" is owned by "payroll", which is not a member.',
      'Two members\' upstream names both become the argument "directory".',
    ]);
  });

  it('has no key mode any more: the id is implicit', () => {
    const concept = teamConcept();
    const withKey = { ...concept, fields: [{ name: 'slug', mode: 'key' }, ...concept.fields.slice(1)] };
    expect(conceptSchema.safeParse(withKey).success).toBe(false);
  });

  it('refuses a member named id, since the mutations take that argument', () => {
    const concept = teamConcept();
    const renamed = { ...concept, members: [{ ...concept.members[0], upstream: 'id' }, concept.members[1]] };
    const messages = conceptSchema.safeParse(renamed).error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toContain('The upstream name "id" becomes the argument "id", which the mutations use already.');
  });
});

describe('validateConcept', () => {
  it('finds nothing wrong with the fixture concept', () => {
    expect(validateConcept(teamConcept(), CONCEPT_SCHEMAS)).toEqual([]);
  });

  it('places a schema error in the document', () => {
    const concept = withDocument(
      'directory',
      'fetch',
      'query ($id: ID!) {\n  team(id: $id) { id slug name colour }\n}',
    );
    expect(validateConcept(concept, CONCEPT_SCHEMAS)).toEqual([
      {
        concept: 'Team',
        member: 'directory',
        operation: 'fetch',
        message: 'Cannot query field "colour" on type "Team".',
        line: 2,
        column: 32,
      },
    ]);
  });

  it('places a syntax error', () => {
    const [problem] = validateConcept(withDocument('billing', 'delete', 'mutation {'), CONCEPT_SCHEMAS);
    expect(problem).toMatchObject({ member: 'billing', operation: 'delete', line: 1, column: 11 });
  });

  it('refuses a document of the wrong operation type', () => {
    const concept = withDocument('directory', 'delete', 'query ($id: ID!) { team(id: $id) { id } }');
    expect(validateConcept(concept, CONCEPT_SCHEMAS)).toEqual([
      expect.objectContaining({
        operation: 'delete',
        message: 'A delete document is a mutation, not a query.',
        line: 1,
      }),
    ]);
  });

  it('refuses a required variable that binds nothing, at its definition', () => {
    const concept = withDocument(
      'billing',
      'update',
      'mutation ($id: ID!, $label: String!) { changeAccount(id: $id, displayName: $label) { id } }',
    );
    const problems = validateConcept(concept, CONCEPT_SCHEMAS);
    expect(problems).toContainEqual(
      expect.objectContaining({
        message: expect.stringMatching(/^\$label is required but binds nothing/),
        line: 1,
        column: 21,
      }),
    );
  });

  it('lets an optional variable bind nothing', () => {
    const concept = withDocument(
      'billing',
      'update',
      'mutation ($id: ID!, $slug: String, $name: String, $tier: Plan) { changeAccount(id: $id, handle: $slug, displayName: $name, plan: $tier) { id } }',
    );
    expect(validateConcept(concept, CONCEPT_SCHEMAS)).toEqual([]);
  });

  it("refuses a variable bound to another member's owned field", () => {
    const concept = withDocument(
      'directory',
      'update',
      'mutation ($id: ID!, $slug: String, $name: String, $plan: String) { renameTeam(id: $id, slug: $slug, name: $plan) { id } }',
    );
    expect(validateConcept(concept, CONCEPT_SCHEMAS).map((problem) => problem.message)).toContain(
      '$plan binds "plan", which billing owns, not directory.',
    );
  });

  it.each(['fetch', 'create', 'update', 'delete'] as const)('wants $id in the %s document', (operation) => {
    const concept = teamConcept();
    const directory = concept.members[0]?.documents[operation] ?? '';
    const withoutId = directory.replace('$id: ID!', '$ref: ID').replaceAll('id: $id', 'id: $ref');
    const problems = validateConcept(withDocument('directory', operation, withoutId), CONCEPT_SCHEMAS);
    expect(problems.map((problem) => problem.message)).toContain(
      `A ${operation} document binds the entity's Symphony UUID as $id, declared ID! or String!.`,
    );
  });

  it('wants $id declared ID! or String!', () => {
    const concept = withDocument('directory', 'delete', 'mutation ($id: ID) { removeTeam(id: $id) }');
    expect(validateConcept(concept, CONCEPT_SCHEMAS).map((problem) => problem.message)).toContain(
      "$id is declared ID! or String!, since every delete needs the entity's UUID; this one is ID.",
    );
  });

  it('wants every shared field in creates and updates', () => {
    const concept = withDocument(
      'directory',
      'create',
      'mutation ($id: ID!, $name: String!) { addTeam(input: { id: $id, slug: "x", name: $name }) { id } }',
    );
    expect(validateConcept(concept, CONCEPT_SCHEMAS).map((problem) => problem.message)).toEqual([
      'A create document binds every shared field, since each member stores it; $slug is missing.',
    ]);
  });

  it('wants the fetch to select the id and every shared field', () => {
    const fetchMissing = withDocument('billing', 'fetch', 'query ($id: ID!) { account(id: $id) { handle plan } }');
    expect(validateConcept(fetchMissing, CONCEPT_SCHEMAS).map((problem) => problem.message)).toEqual([
      'The fetch selects the entity\'s id as "id" directly under account, since the gateway merges on it; alias the upstream\'s field if it is called something else (id: uuid).',
      'The fetch selects "slug" directly under account; alias the upstream\'s field to that name if it differs.',
      'The fetch selects "name" directly under account; alias the upstream\'s field to that name if it differs.',
    ]);
  });

  it('takes an id the fetch selects under an alias', () => {
    const aliased = withDocument(
      'billing',
      'fetch',
      'query ($id: ID!) { account(id: $id) { id: handle slug: handle name: displayName } }',
    );
    expect(validateConcept(aliased, CONCEPT_SCHEMAS)).toEqual([]);
  });

  it('wants a shared field to have one built-in scalar type everywhere', () => {
    const concept = withDocument(
      'billing',
      'update',
      'mutation ($id: ID!, $slug: String, $name: Int, $plan: Plan) { changeAccount(id: $id, handle: $slug, displayName: $name, plan: $plan) { id } }',
    );
    const problems = validateConcept(concept, CONCEPT_SCHEMAS);
    expect(problems.map((problem) => problem.message)).toContain(
      '"name" is Int here but String in directory\'s create.',
    );
  });

  it('reports a member whose upstream has no schema', () => {
    const directoryOnly = new Map([...CONCEPT_SCHEMAS].filter(([name]) => name === 'directory'));
    const problems = validateConcept(teamConcept(), directoryOnly);
    expect(problems).toEqual([expect.objectContaining({ member: 'billing', operation: null })]);
  });
});

describe('validateConcepts', () => {
  it('refuses two concepts with one name', () => {
    const problems = validateConcepts([teamConcept(), teamConcept()], CONCEPT_SCHEMAS);
    expect(problems).toEqual([
      expect.objectContaining({ concept: 'Team', member: null, message: expect.stringMatching(/^Two concepts/) }),
    ]);
  });
});
