import {
  draftOf,
  draftProblems,
  overrideFromDraft,
  type SourceWiringData,
  type WiringParts,
  wiringRows,
} from '../../web/src/concepts/wiring-rows.ts';

const generated: WiringParts = {
  renames: {
    types: [{ from: 'Group', to: 'Team' }],
    fields: [
      { from: 'Group.label', to: 'name' },
      { from: 'Group.code', to: 'slug' },
    ],
  },
  mergeKeys: [{ type: 'Team', keyField: 'id', lookupField: 'group', keyArg: null }],
};

/** A source whose override renames a field differently, removes a generated one and adds a key. */
const overridden: SourceWiringData = {
  source: 'directory',
  renames: {
    types: [{ from: 'Group', to: 'Team' }],
    fields: [{ from: 'Group.label', to: 'title' }],
  },
  mergeKeys: [
    { type: 'Team', keyField: 'id', lookupField: 'group', keyArg: null },
    { type: 'Person', keyField: 'id', lookupField: 'person', keyArg: 'personId' },
  ],
  generated,
  override: {
    upstream: 'directory',
    renames: { fields: { 'Group.label': 'title', 'Group.code': null } },
    mergeKeys: [{ type: 'Person', keyField: 'id', lookupField: 'person', keyArg: 'personId' }],
  },
  origins: [
    { entry: 'type:Group', origin: 'GENERATED' },
    { entry: 'field:Group.label', origin: 'OVERRIDE' },
    { entry: 'key:Team', origin: 'GENERATED' },
    { entry: 'key:Person', origin: 'OVERRIDE' },
  ],
};

describe('wiringRows', () => {
  it('marks each entry generated or override, and lists the generated entries the override removes', () => {
    const rows = wiringRows(overridden);
    expect(rows.map((row) => [row.id, row.origin, row.to, row.generatedTo])).toEqual([
      ['type:Group', 'generated', 'Team', null],
      ['field:Group.label', 'override', 'title', 'name'],
      ['field:Group.code', 'removed', 'slug', 'slug'],
      ['key:Team', 'generated', 'id via group', null],
      ['key:Person', 'override', 'id via person(personId)', null],
    ]);
  });

  it('guesses the origin of an entry the server sent none for', () => {
    const rows = wiringRows({ ...overridden, origins: [] });
    expect(rows.find((row) => row.id === 'type:Group')?.origin).toBe('generated');
    expect(rows.find((row) => row.id === 'field:Group.label')?.origin).toBe('override');
  });

  it('treats every entry of a source with no generated wiring as the override', () => {
    const rows = wiringRows({
      source: 'billing',
      renames: { types: [{ from: 'Account', to: 'Team' }], fields: [] },
      mergeKeys: [],
      generated: null,
      override: { upstream: 'billing', renames: { types: { Account: 'Team' } } },
      origins: [{ entry: 'type:Account', origin: 'OVERRIDE' }],
    });
    expect(rows).toEqual([
      { id: 'type:Account', kind: 'type', from: 'Account', to: 'Team', origin: 'override', generatedTo: null },
    ]);
  });
});

describe('overrideFromDraft', () => {
  it('is empty but for the upstream when the draft is the generated wiring', () => {
    expect(overrideFromDraft('directory', generated, draftOf(generated), null)).toEqual({ upstream: 'directory' });
  });

  it('round-trips an override through the form unchanged', () => {
    const override = overrideFromDraft('directory', generated, draftOf(overridden), overridden.override);
    expect(override).toEqual(overridden.override);
  });

  it('records edits to generated entries, removals and additions', () => {
    const draft = draftOf(generated);
    draft.types[0] = { from: 'Group', to: 'Squad' };
    draft.fields = draft.fields.filter((rename) => rename.from !== 'Group.code');
    draft.fields.push({ from: ' Group.size ', to: 'headcount ' });
    draft.mergeKeys = [];
    expect(overrideFromDraft('directory', generated, draft, null)).toEqual({
      upstream: 'directory',
      renames: { types: { Group: 'Squad' }, fields: { 'Group.code': null, 'Group.size': 'headcount' } },
      removeMergeKeys: ['Team'],
    });
  });

  it('keeps the members of a stored override it does not write', () => {
    const previous = { upstream: 'directory', note: 'kept', renames: { types: { Group: 'Squad' } } };
    expect(overrideFromDraft('directory', generated, draftOf(generated), previous)).toEqual({
      upstream: 'directory',
      note: 'kept',
    });
  });

  it('writes an argument only when one is given', () => {
    const draft = draftOf(null);
    draft.mergeKeys.push({ type: 'Team', keyField: 'id', lookupField: 'team', keyArg: '' });
    expect(overrideFromDraft('billing', null, draft, null).mergeKeys).toEqual([
      { type: 'Team', keyField: 'id', lookupField: 'team' },
    ]);
  });
});

describe('draftProblems', () => {
  it('accepts a draft whose blank rows it can drop', () => {
    const draft = draftOf(generated);
    draft.types.push({ from: ' ', to: '' });
    expect(draftProblems(draft)).toEqual([]);
  });

  it('names half-filled rows and entries given twice', () => {
    const draft = draftOf(generated);
    draft.types.push({ from: 'Group', to: 'Squad' }, { from: 'Person', to: '' });
    draft.mergeKeys.push({ type: 'Team', keyField: 'id', lookupField: '', keyArg: '' });
    expect(draftProblems(draft)).toEqual([
      'Give every type rename both a source name and a unified name.',
      'Give every merge key a type, a key field and a lookup field.',
      'The type Group is renamed more than once.',
      'The type Team has more than one merge key.',
    ]);
  });
});
