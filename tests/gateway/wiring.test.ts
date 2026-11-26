// Wiring generated from concepts, edited by overrides, and composed: each member's fetch document names the entity
// type, its aliases rename fields, and its lookup root field becomes the merge key.
import { buildSchema, type GraphQLSchema, Kind, type ObjectTypeDefinitionNode, parse } from 'graphql';
import type { Concept } from '../../server/concepts/concept.ts';
import { composeSupergraph } from '../../server/gateway/compose.ts';
import type { Source } from '../../server/gateway/sources.ts';
import {
  applyWiringOverrides,
  CONCEPT_SOURCE_NAME,
  deriveWiring,
  type SourceWiring,
  sourceWiringFields,
  type WiringOverride,
  wiringOverrideSchema,
} from '../../server/gateway/wiring.ts';

const DIRECTORY_SDL = /* GraphQL */ `
  type Group { id: ID! title: String! size: Int! }
  type Query { group(id: ID!): Group }
`;

const BILLING_SDL = /* GraphQL */ `
  type Account { uuid: ID! displayName: String! plan: String! }
  type Person { id: ID! email: String! }
  type Query { account(accountId: ID!): Account person(id: ID!): Person }
`;

/** An upstream that already uses the concept's names. */
const PEOPLE_SDL = /* GraphQL */ `
  type Team { id: ID! label: String }
  type Query { peopleTeam(id: ID!): Team }
`;

/** An upstream whose fields let each problem case be written. */
const ITEMS_SDL = /* GraphQL */ `
  type Item { id: ID! name: String! tags: [Tag!]! }
  type Tag { id: ID! label: String! }
  type Thing { id: ID! }
  type Query {
    item(id: ID!, locale: String): Item
    first: Item
    pair(a: ID!, b: ID!): Item
    itemList(id: ID!): [Item!]!
    itemName(id: ID!): String
  }
`;

const SCHEMAS: ReadonlyMap<string, GraphQLSchema> = new Map([
  ['directory', buildSchema(DIRECTORY_SDL)],
  ['billing', buildSchema(BILLING_SDL)],
  ['people', buildSchema(PEOPLE_SDL)],
  ['items', buildSchema(ITEMS_SDL)],
]);

const DIRECTORY_FETCH = 'query ($id: ID!) { group(id: $id) { id name: title size } }';
const BILLING_FETCH = 'query ($id: ID!) { account(accountId: $id) { id: uuid name: displayName plan } }';
const PERSON_FETCH = 'query ($id: ID!) { person(id: $id) { id mail: email } }';

/** Wiring reads only the fetch document; the others just have to be there. */
const UNUSED_DOCUMENT = 'mutation { unused }';

/**
 * Builds a concept from its name and its members' fetch documents.
 *
 * @param name - The concept's name.
 * @param members - Upstream name and fetch document per member.
 * @returns The concept.
 */
function concept(name: string, members: [upstream: string, fetch: string][]): Concept {
  return {
    name,
    fields: [],
    members: members.map(([upstream, fetch]) => ({
      upstream,
      documents: { fetch, create: UNUSED_DOCUMENT, update: UNUSED_DOCUMENT, delete: UNUSED_DOCUMENT },
    })),
  };
}

const TEAM = concept('Team', [
  ['directory', DIRECTORY_FETCH],
  ['billing', BILLING_FETCH],
]);

/**
 * Finds one source's wiring.
 *
 * @param wiring - Every source's wiring.
 * @param upstream - The source.
 * @returns Its wiring.
 */
function wiringOf<T extends SourceWiring>(wiring: readonly T[], upstream: string): T {
  const found = wiring.find((one) => one.upstream === upstream);
  if (found === undefined) {
    throw new Error(`No wiring for ${upstream}.`);
  }
  return found;
}

describe('deriveWiring', () => {
  it('renames each member type, aliased field and lookup to the concept, keyed by id', () => {
    const { wiring, problems } = deriveWiring([TEAM], SCHEMAS);
    expect(problems).toEqual([]);
    expect(wiringOf(wiring, 'directory')).toEqual({
      upstream: 'directory',
      renames: { types: { Group: 'Team' }, fields: { 'Group.title': 'name', 'Query.group': 'directoryTeam' } },
      mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'directoryTeam' }],
    });
    expect(wiringOf(wiring, 'billing')).toEqual({
      upstream: 'billing',
      renames: {
        types: { Account: 'Team' },
        fields: { 'Account.uuid': 'id', 'Account.displayName': 'name', 'Query.account': 'billingTeam' },
      },
      mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'billingTeam', keyArg: 'accountId' }],
    });
  });

  it('adds no renames for a member that already uses the concept names', () => {
    const { wiring, problems } = deriveWiring(
      [concept('Team', [['people', 'query ($id: ID!) { peopleTeam(id: $id) { id label } }']])],
      SCHEMAS,
    );
    expect(problems).toEqual([]);
    expect(wiringOf(wiring, 'people')).toEqual({
      upstream: 'people',
      renames: { types: {}, fields: {} },
      mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'peopleTeam' }],
    });
  });

  it('wires the concept subgraph by Query.<name>(id:), and sorts sources by name', () => {
    const { wiring } = deriveWiring([TEAM, concept('Person', [['billing', PERSON_FETCH]])], SCHEMAS);
    expect(wiring.map((one) => one.upstream)).toEqual(['billing', 'directory', CONCEPT_SOURCE_NAME]);
    expect(wiringOf(wiring, CONCEPT_SOURCE_NAME)).toEqual({
      upstream: CONCEPT_SOURCE_NAME,
      renames: { types: {}, fields: {} },
      mergeKeys: [
        { type: 'Team', keyField: 'id', lookupField: 'team' },
        { type: 'Person', keyField: 'id', lookupField: 'person' },
      ],
    });
  });

  it('merges two concepts that share an upstream into one wiring', () => {
    const { wiring, problems } = deriveWiring([TEAM, concept('Person', [['billing', PERSON_FETCH]])], SCHEMAS);
    expect(problems).toEqual([]);
    expect(wiringOf(wiring, 'billing')).toEqual({
      upstream: 'billing',
      renames: {
        types: { Account: 'Team' },
        fields: {
          'Account.uuid': 'id',
          'Account.displayName': 'name',
          'Query.account': 'billingTeam',
          'Person.email': 'mail',
          'Query.person': 'billingPerson',
        },
      },
      mergeKeys: [
        { type: 'Team', keyField: 'id', lookupField: 'billingTeam', keyArg: 'accountId' },
        { type: 'Person', keyField: 'id', lookupField: 'billingPerson' },
      ],
    });
  });

  it('refuses a second concept that renames the same type to another name', () => {
    const { wiring, problems } = deriveWiring([TEAM, concept('Org', [['billing', BILLING_FETCH]])], SCHEMAS);
    const messages = problems.filter((problem) => problem.concept === 'Org').map((problem) => problem.message);
    expect(messages.join('\n')).toContain('Account is renamed to both Team and Org');
    expect(messages.join('\n')).toContain('Query.account is renamed to both billingTeam and billingOrg');
    expect(wiringOf(wiring, 'billing').renames.types).toEqual({ Account: 'Team' });
  });

  it('refuses two source types renamed to one name, and two merge keys for one type', () => {
    const { wiring, problems } = deriveWiring(
      [
        concept('Team', [['billing', BILLING_FETCH]]),
        concept('Team', [['billing', 'query ($id: ID!) { person(id: $id) { id } }']]),
      ],
      SCHEMAS,
    );
    const messages = problems.map((problem) => problem.message).join('\n');
    expect(messages).toContain('Both Account and Person are renamed to Team');
    expect(messages).toContain('Team has two merge keys');
    expect(problems.every((problem) => problem.upstream === 'billing')).toBe(true);
    expect(wiringOf(wiring, 'billing').mergeKeys).toEqual([
      { type: 'Team', keyField: 'id', lookupField: 'billingTeam', keyArg: 'accountId' },
    ]);
  });

  it.each([
    ['a parse error', 'query { item(', 'does not parse'],
    ['a fragment', 'query ($id: ID!) { item(id: $id) { ...F } } fragment F on Item { id }', 'fragments'],
    ['an inline fragment', 'query ($id: ID!) { item(id: $id) { ... on Item { id } } }', 'fragments'],
    ['a directive', 'query ($id: ID!) { item(id: $id) { id name @include(if: true) } }', 'directives'],
    ['a mutation', 'mutation ($id: ID!) { item(id: $id) { id } }', 'exactly one query'],
    ['an unknown field', 'query ($id: ID!) { item(id: $id) { id nope } }', 'does not validate'],
    ['two root fields', 'query ($id: ID!) { item(id: $id) { id } first { id } }', 'exactly one root field'],
    ['a list root field', 'query ($id: ID!) { itemList(id: $id) { id } }', 'returns a list'],
    ['a scalar root field', 'query ($id: ID!) { itemName(id: $id) }', 'not an object type'],
    ['an argument not bound to $id', 'query ($id: ID!) { item(id: $id, locale: "en") { id } }', '"locale"'],
    ['no $id binding', 'query { first { id } }', 'no argument bound to $id'],
    ['$id bound twice', 'query ($id: ID!) { pair(a: $id, b: $id) { id } }', 'more than one argument'],
    ['no id selected', 'query ($id: ID!) { item(id: $id) { name } }', 'must select'],
    ['an alias inside a nested selection', 'query ($id: ID!) { item(id: $id) { id tags { text: label } } }', 'tags'],
    [
      'an alias naming an existing field',
      'query ($id: ID!) { item(id: $id) { id tags: name } }',
      'already has a field',
    ],
    ['an aliased introspection field', 'query ($id: ID!) { item(id: $id) { id kind: __typename } }', 'introspection'],
  ])('reports %s and wires nothing for that member', (_case, fetch, expected) => {
    const { wiring, problems } = deriveWiring([concept('Widget', [['items', fetch]])], SCHEMAS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ upstream: 'items', concept: 'Widget' });
    expect(problems[0]?.message).toContain(expected);
    expect(wiringOf(wiring, 'items')).toEqual({ upstream: 'items', renames: { types: {}, fields: {} }, mergeKeys: [] });
  });

  it('reports a concept name the upstream already gives another type', () => {
    const { problems } = deriveWiring(
      [concept('Thing', [['items', 'query ($id: ID!) { item(id: $id) { id } }']])],
      SCHEMAS,
    );
    expect(problems.map((problem) => problem.message)).toEqual([expect.stringContaining('type named Thing')]);
  });

  it('reports a member whose upstream has no cached schema', () => {
    const { problems } = deriveWiring([concept('Team', [['missing', DIRECTORY_FETCH]])], SCHEMAS);
    expect(problems).toEqual([{ upstream: 'missing', concept: 'Team', message: expect.stringContaining('missing') }]);
  });

  it('reports a member that uses the concept subgraph name', () => {
    const { problems } = deriveWiring([concept('Team', [[CONCEPT_SOURCE_NAME, DIRECTORY_FETCH]])], SCHEMAS);
    expect(problems[0]?.message).toContain('reserved');
  });
});

describe('applyWiringOverrides', () => {
  const generated = deriveWiring([TEAM], SCHEMAS).wiring;

  it('passes generated wiring through untouched, every entry marked generated', () => {
    const directory = wiringOf(applyWiringOverrides(generated, []), 'directory');
    expect(directory.renames).toEqual(wiringOf(generated, 'directory').renames);
    expect(directory.override).toBeNull();
    expect(directory.origins).toEqual({
      'type:Group': 'generated',
      'field:Group.title': 'generated',
      'field:Query.group': 'generated',
      'key:Team': 'generated',
    });
  });

  it('removes, replaces and adds renames, and replaces a merge key of the same type', () => {
    const override: WiringOverride = {
      upstream: 'billing',
      renames: { fields: { 'Account.displayName': null, 'Query.account': 'accountTeam', 'Account.plan': 'tier' } },
      mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'accountTeam', keyArg: 'accountId' }],
    };
    const billing = wiringOf(applyWiringOverrides(generated, [override]), 'billing');
    expect(billing.renames).toEqual({
      types: { Account: 'Team' },
      fields: { 'Account.uuid': 'id', 'Query.account': 'accountTeam', 'Account.plan': 'tier' },
    });
    expect(billing.mergeKeys).toEqual([override.mergeKeys?.[0]]);
    expect(billing.origins).toEqual({
      'type:Account': 'generated',
      'field:Account.uuid': 'generated',
      'field:Query.account': 'override',
      'field:Account.plan': 'override',
      'key:Team': 'override',
    });
    expect(billing.generated).toEqual(wiringOf(generated, 'billing'));
    expect(billing.override).toBe(override);
  });

  it('drops generated merge keys by type and adds new ones', () => {
    const extra = { type: 'Group', keyField: 'id', lookupField: 'group' };
    const directory = wiringOf(
      applyWiringOverrides(generated, [{ upstream: 'directory', removeMergeKeys: ['Team'], mergeKeys: [extra] }]),
      'directory',
    );
    expect(directory.mergeKeys).toEqual([extra]);
    expect(directory.origins['key:Team']).toBeUndefined();
    expect(directory.origins['key:Group']).toBe('override');
  });

  it('defines wiring from nothing for an upstream with only an override', () => {
    const effective = applyWiringOverrides(generated, [
      { upstream: 'crm', renames: { types: { Client: 'Team' }, fields: { 'Client.gone': null } } },
    ]);
    expect(effective.map((one) => one.upstream)).toEqual(['billing', 'crm', 'directory', CONCEPT_SOURCE_NAME]);
    expect(wiringOf(effective, 'crm')).toMatchObject({
      renames: { types: { Client: 'Team' }, fields: {} },
      mergeKeys: [],
      generated: null,
      origins: { 'type:Client': 'override' },
    });
  });

  it('refuses two overrides for one upstream', () => {
    expect(() => applyWiringOverrides(generated, [{ upstream: 'crm' }, { upstream: 'crm' }])).toThrow('crm');
  });
});

describe('wiringOverrideSchema', () => {
  it('accepts an override with removals, renames and merge keys', () => {
    const override = {
      upstream: 'billing',
      renames: { types: { Account: 'Team' }, fields: { 'Account.plan': null } },
      mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'billingTeam', keyArg: 'accountId' }],
      removeMergeKeys: ['Person'],
    };
    expect(wiringOverrideSchema.parse(override)).toEqual(override);
  });

  it.each([
    ['a field rename not keyed Type.field', { upstream: 'b', renames: { fields: { plan: 'tier' } } }],
    ['a rename to a name GraphQL refuses', { upstream: 'b', renames: { types: { Account: 'not-a-name' } } }],
    [
      'two merge keys for one type',
      {
        upstream: 'b',
        mergeKeys: [
          { type: 'Team', keyField: 'id', lookupField: 'a' },
          { type: 'Team', keyField: 'id', lookupField: 'b' },
        ],
      },
    ],
  ])('rejects %s', (_case, override) => {
    expect(wiringOverrideSchema.safeParse(override).success).toBe(false);
  });
});

describe('effective wiring in composition', () => {
  it('composes one merged entity with fields from every source', async () => {
    const effective = applyWiringOverrides(deriveWiring([TEAM], SCHEMAS).wiring, []);
    const subgraph = buildSchema('type Team { id: ID! presence: String } type Query { team(id: ID!): Team }');
    const wired = (upstream: string) => sourceWiringFields(wiringOf(effective, upstream));
    const sources: Source[] = [
      {
        name: 'directory',
        kind: 'graphql',
        endpoint: 'http://directory.test/graphql',
        sdl: DIRECTORY_SDL,
        ...wired('directory'),
      },
      {
        name: 'billing',
        kind: 'graphql',
        endpoint: 'http://billing.test/graphql',
        sdl: BILLING_SDL,
        ...wired('billing'),
      },
      { name: CONCEPT_SOURCE_NAME, kind: 'schema', schema: subgraph, ...wired(CONCEPT_SOURCE_NAME) },
    ];
    const supergraph = await composeSupergraph(sources);
    const fieldsOf = (typeName: string): string[] => {
      const definition = parse(supergraph.sdl).definitions.find(
        (one): one is ObjectTypeDefinitionNode =>
          one.kind === Kind.OBJECT_TYPE_DEFINITION && one.name.value === typeName,
      );
      return (definition?.fields ?? []).map((field) => field.name.value);
    };
    expect(fieldsOf('Team')).toEqual(expect.arrayContaining(['id', 'name', 'size', 'plan', 'presence']));
    expect(fieldsOf('Team')).not.toContain('uuid');
    expect(fieldsOf('Query')).toEqual(expect.arrayContaining(['team', 'directoryTeam', 'billingTeam']));
    expect(fieldsOf('Query')).not.toContain('account');
  });
});
