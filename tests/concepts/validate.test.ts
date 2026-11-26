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

  it('refuses two key fields, a foreign owner and a repeated member', () => {
    const concept = teamConcept();
    const broken = {
      ...concept,
      fields: [...concept.fields, { name: 'id', mode: 'key' }, { name: 'tax', mode: 'owned', owner: 'payroll' }],
      members: [...concept.members, concept.members[0]],
    };
    const result = conceptSchema.safeParse(broken);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual([
      'A concept has exactly one key field; this one has 2.',
      'The upstream "directory" is listed as a member more than once.',
      'The field "tax" is owned by "payroll", which is not a member.',
      'Two members\' upstream names both become the argument "directory".',
    ]);
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
      'query ($key: String!) {\n  team(slug: $key) { slug name colour }\n}',
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
    const concept = withDocument('directory', 'delete', 'query ($key: String!) { team(slug: $key) { slug } }');
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
      'mutation ($key: String!, $label: String!) { changeAccount(handle: $key, displayName: $label) { handle } }',
    );
    const problems = validateConcept(concept, CONCEPT_SCHEMAS);
    expect(problems).toContainEqual(
      expect.objectContaining({
        message: expect.stringMatching(/^\$label is required but binds nothing/),
        line: 1,
        column: 26,
      }),
    );
  });

  it('lets an optional variable bind nothing', () => {
    const concept = withDocument(
      'billing',
      'update',
      'mutation ($key: String!, $name: String, $tier: Plan) { changeAccount(handle: $key, displayName: $name, plan: $tier) { handle } }',
    );
    expect(validateConcept(concept, CONCEPT_SCHEMAS)).toEqual([]);
  });

  it("refuses a variable bound to another member's owned field", () => {
    const concept = withDocument(
      'directory',
      'update',
      'mutation ($key: String!, $name: String!, $plan: String!) { renameTeam(slug: $key, name: $plan) { slug } }',
    );
    expect(validateConcept(concept, CONCEPT_SCHEMAS).map((problem) => problem.message)).toContain(
      '$plan binds "plan", which billing owns, not directory.',
    );
  });

  it('wants the key in every document and every shared field in creates and updates', () => {
    const concept = withDocument(
      'directory',
      'create',
      'mutation ($name: String!) { addTeam(input: { slug: "x", name: $name }) { slug } }',
    );
    const fetchMissing = withDocument(
      'billing',
      'fetch',
      'query ($key: String!) { account(handle: $key) { handle plan } }',
    );
    expect(validateConcept(concept, CONCEPT_SCHEMAS).map((problem) => problem.message)).toEqual([
      'A create document binds the key, as $key or $slug.',
    ]);
    expect(validateConcept(fetchMissing, CONCEPT_SCHEMAS).map((problem) => problem.message)).toEqual([
      'The fetch selects "slug" directly under account; alias the upstream\'s field to that name if it differs.',
      'The fetch selects "name" directly under account; alias the upstream\'s field to that name if it differs.',
    ]);
  });

  it('wants a shared field to have one built-in scalar type everywhere', () => {
    const concept = withDocument(
      'billing',
      'update',
      'mutation ($key: String!, $name: Int, $plan: Plan) { changeAccount(handle: $key, displayName: $name, plan: $plan) { handle } }',
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
