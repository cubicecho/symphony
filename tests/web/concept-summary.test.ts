import {
  conceptProblemsOf,
  parseDefinitionText,
  placeOf,
  problemsAt,
  summarizeDefinition,
} from '../../web/src/concepts/concept-summary.ts';

const definition = {
  name: 'Team',
  fields: [
    { name: 'name', mode: 'shared' },
    { name: 'plan', mode: 'owned', owner: 'billing' },
  ],
  members: [
    { upstream: 'directory', documents: { fetch: 'query F { a }', create: 'mutation C { a }' } },
    { upstream: 'billing', documents: { fetch: 'query F { b }', update: 'mutation U { b }', delete: 7 } },
  ],
  priority: 3,
};

describe('summarizeDefinition', () => {
  it('splits shared and owned fields and lists each member with its documents in operation order', () => {
    expect(summarizeDefinition(definition)).toEqual({
      name: 'Team',
      shared: [{ name: 'name', owner: null }],
      owned: [{ name: 'plan', owner: 'billing' }],
      members: [
        {
          upstream: 'directory',
          documents: [
            { operation: 'fetch', text: 'query F { a }' },
            { operation: 'create', text: 'mutation C { a }' },
          ],
          owned: [],
        },
        {
          upstream: 'billing',
          documents: [
            { operation: 'fetch', text: 'query F { b }' },
            { operation: 'update', text: 'mutation U { b }' },
          ],
          owned: ['plan'],
        },
      ],
    });
  });

  it('summarizes a half-typed draft as far as it goes', () => {
    expect(summarizeDefinition({ fields: [{ mode: 'shared' }], members: 'none' })).toEqual({
      name: null,
      shared: [],
      owned: [],
      members: [],
    });
    expect(summarizeDefinition(null).members).toEqual([]);
  });
});

describe('parseDefinitionText', () => {
  it('reads JSON, or says why it is not', () => {
    expect(parseDefinitionText('{"name":"Team"}')).toEqual({ ok: true, value: { name: 'Team' } });
    expect(parseDefinitionText('{name').ok).toBe(false);
  });
});

describe('conceptProblemsOf', () => {
  it('reads the problems a refused save carries in its extensions', () => {
    const error = Object.assign(new Error('Refused'), {
      extensions: {
        code: 'BAD_USER_INPUT',
        problems: [
          { concept: 'Team', member: 'billing', operation: 'fetch', message: 'No field b', line: 1, column: 11 },
          { concept: 'Team', message: 'No members' },
          { nothing: true },
        ],
      },
    });
    expect(conceptProblemsOf(error)).toEqual([
      { concept: 'Team', member: 'billing', operation: 'fetch', message: 'No field b', line: 1, column: 11 },
      { concept: 'Team', member: null, operation: null, message: 'No members', line: null, column: null },
    ]);
  });

  it('is null for an error that carries none', () => {
    expect(conceptProblemsOf(new Error('Network'))).toBeNull();
    expect(conceptProblemsOf(undefined)).toBeNull();
  });
});

describe('problemsAt and placeOf', () => {
  const problems = [
    { concept: 'Team', member: 'billing', operation: 'fetch', message: 'a', line: 2, column: 3 },
    { concept: 'Team', member: 'billing', operation: null, message: 'b', line: null, column: null },
    { concept: 'Team', member: null, operation: null, message: 'c', line: null, column: null },
  ];

  it('picks the problems placed at one member document, one member, or the concept', () => {
    expect(problemsAt(problems, 'billing', 'fetch').map((problem) => problem.message)).toEqual(['a']);
    expect(problemsAt(problems, 'billing', null).map((problem) => problem.message)).toEqual(['b']);
    expect(problemsAt(problems, null, null).map((problem) => problem.message)).toEqual(['c']);
  });

  it('names where a problem is', () => {
    expect(problems.map(placeOf)).toEqual(['billing · fetch · 2:3', 'billing', null]);
  });
});
