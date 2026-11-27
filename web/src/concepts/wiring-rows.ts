// A source's wiring as the screen shows and edits it. The server sends the effective wiring, the generated wiring
// it came from, the stored override and an origin per entry; these helpers turn that into table rows, into a draft
// the form edits, and the draft back into the smallest override that produces it.

/** The unified name a source name is renamed to. */
export interface Rename {
  from: string;
  to: string;
}

/** How the gateway fetches an entity from a source by key. */
export interface MergeKey {
  type: string;
  keyField: string;
  lookupField: string;
  keyArg?: string | null | undefined;
}

/** Renames and merge keys, as both the effective and the generated wiring carry them. */
export interface WiringParts {
  renames: { types: readonly Rename[]; fields: readonly Rename[] };
  mergeKeys: readonly MergeKey[];
}

/** One source's wiring, as the admin API sends it. */
export interface SourceWiringData extends WiringParts {
  source: string;
  /** Null when no concept generates wiring for this source. */
  generated: WiringParts | null;
  /** The stored override as JSON; null when there is none. */
  override: unknown;
  /** `entry` is `type:<Source>`, `field:<Source.field>` or `key:<Type>`; `origin` is GENERATED or OVERRIDE. */
  origins: readonly { entry: string; origin: string }[];
}

/** What a row of wiring is. */
export type WiringEntryKind = 'type' | 'field' | 'key';

/**
 * Where a row came from. `removed` is a generated entry the override takes out, listed so it can be seen and put
 * back.
 */
export type WiringRowOrigin = 'generated' | 'override' | 'removed';

/** One row of a source's wiring table. */
export interface WiringRow {
  /** The origin entry's name, unique within the source: `type:Team`, `field:Team.title`, `key:Team`. */
  id: string;
  kind: WiringEntryKind;
  /** The source's type name or field coordinate, or the merged type for a key. */
  from: string;
  /** The unified name, or how a key is looked up. */
  to: string;
  origin: WiringRowOrigin;
  /** What the generated wiring says for this entry, when an override changes or removes it. */
  generatedTo: string | null;
}

/** One rename row as the form holds it. */
export interface RenameDraft {
  from: string;
  to: string;
}

/** One merge key row as the form holds it. `keyArg` is empty when the argument is named like the key field. */
export interface MergeKeyDraft {
  type: string;
  keyField: string;
  lookupField: string;
  keyArg: string;
}

/** What the override form holds: the effective wiring, every entry editable. */
export interface WiringDraft {
  types: RenameDraft[];
  fields: RenameDraft[];
  mergeKeys: MergeKeyDraft[];
}

/** A wiring override, as setWiringOverride takes it. Keys this app does not know are carried over unchanged. */
export interface WiringOverrideInput {
  [key: string]: unknown;
  upstream: string;
  renames?: { types?: Record<string, string | null>; fields?: Record<string, string | null> };
  mergeKeys?: MergeKey[];
  removeMergeKeys?: string[];
}

/** The origin-entry prefix of each kind. */
const ENTRY_PREFIX: Readonly<Record<WiringEntryKind, string>> = { type: 'type:', field: 'field:', key: 'key:' };

/** The override members this app writes; the rest of a stored override is kept as it is. */
const OVERRIDE_KEYS = new Set(['upstream', 'renames', 'mergeKeys', 'removeMergeKeys']);

/**
 * Describes how a merge key looks an entity up.
 *
 * @param mergeKey - The key.
 * @returns "id via teamById(teamId)", or "id via team" when the argument is named like the key field.
 */
export function describeMergeKey(mergeKey: MergeKey): string {
  const hasArg = mergeKey.keyArg !== undefined && mergeKey.keyArg !== null && mergeKey.keyArg !== '';
  const lookup = hasArg ? `${mergeKey.lookupField}(${mergeKey.keyArg})` : mergeKey.lookupField;
  return `${mergeKey.keyField} via ${lookup}`;
}

/**
 * Reads an origin the server sent, or guesses one for an entry it sent none for.
 *
 * @param origins - The server's origins by entry.
 * @param entry - The entry.
 * @param isGenerated - Whether the generated wiring has the entry with the same value.
 * @returns Generated or override.
 */
function originOf(origins: ReadonlyMap<string, string>, entry: string, isGenerated: boolean): WiringRowOrigin {
  const origin = origins.get(entry)?.toLowerCase();
  if (origin === 'generated' || origin === 'override') {
    return origin;
  }
  return isGenerated ? 'generated' : 'override';
}

/**
 * Builds the rows for one kind of rename.
 *
 * @param kind - Type or field.
 * @param effective - The renames as served.
 * @param generated - The renames as generated.
 * @param origins - The server's origins by entry.
 * @returns The effective renames, then the generated ones the override removes.
 */
function renameRows(
  kind: 'type' | 'field',
  effective: readonly Rename[],
  generated: readonly Rename[],
  origins: ReadonlyMap<string, string>,
): WiringRow[] {
  const generatedByFrom = new Map(generated.map((rename) => [rename.from, rename.to]));
  const effectiveFroms = new Set(effective.map((rename) => rename.from));
  const rows = effective.map((rename): WiringRow => {
    const id = `${ENTRY_PREFIX[kind]}${rename.from}`;
    const generatedTo = generatedByFrom.get(rename.from) ?? null;
    const origin = originOf(origins, id, generatedTo === rename.to);
    return {
      id,
      kind,
      from: rename.from,
      to: rename.to,
      origin,
      generatedTo: origin === 'override' ? generatedTo : null,
    };
  });
  const removed = generated
    .filter((rename) => effectiveFroms.has(rename.from) === false)
    .map(
      (rename): WiringRow => ({
        id: `${ENTRY_PREFIX[kind]}${rename.from}`,
        kind,
        from: rename.from,
        to: rename.to,
        origin: 'removed',
        generatedTo: rename.to,
      }),
    );
  return [...rows, ...removed];
}

/**
 * Tells whether two merge keys look an entity up the same way.
 *
 * @param a - One key.
 * @param b - Another.
 * @returns True when every part matches, an absent argument matching an empty one.
 */
function sameMergeKey(a: MergeKey, b: MergeKey): boolean {
  return (
    a.type === b.type &&
    a.keyField === b.keyField &&
    a.lookupField === b.lookupField &&
    (a.keyArg ?? '') === (b.keyArg ?? '')
  );
}

/**
 * Builds the rows for a source's merge keys.
 *
 * @param effective - The keys as served.
 * @param generated - The keys as generated.
 * @param origins - The server's origins by entry.
 * @returns The effective keys, then the generated ones the override removes.
 */
function mergeKeyRows(
  effective: readonly MergeKey[],
  generated: readonly MergeKey[],
  origins: ReadonlyMap<string, string>,
): WiringRow[] {
  const generatedByType = new Map(generated.map((mergeKey) => [mergeKey.type, mergeKey]));
  const effectiveTypes = new Set(effective.map((mergeKey) => mergeKey.type));
  const rows = effective.map((mergeKey): WiringRow => {
    const id = `${ENTRY_PREFIX.key}${mergeKey.type}`;
    const generatedKey = generatedByType.get(mergeKey.type);
    const isGenerated = generatedKey !== undefined && sameMergeKey(generatedKey, mergeKey);
    const origin = originOf(origins, id, isGenerated);
    return {
      id,
      kind: 'key',
      from: mergeKey.type,
      to: describeMergeKey(mergeKey),
      origin,
      generatedTo: origin === 'override' && generatedKey !== undefined ? describeMergeKey(generatedKey) : null,
    };
  });
  const removed = generated
    .filter((mergeKey) => effectiveTypes.has(mergeKey.type) === false)
    .map(
      (mergeKey): WiringRow => ({
        id: `${ENTRY_PREFIX.key}${mergeKey.type}`,
        kind: 'key',
        from: mergeKey.type,
        to: describeMergeKey(mergeKey),
        origin: 'removed',
        generatedTo: describeMergeKey(mergeKey),
      }),
    );
  return [...rows, ...removed];
}

/**
 * Turns a source's wiring into table rows: type renames, field renames, then merge keys, each marked generated,
 * override or removed.
 *
 * @param wiring - The source's wiring as the admin API sends it.
 * @returns One row per effective entry, and one per generated entry the override removes.
 */
export function wiringRows(wiring: SourceWiringData): WiringRow[] {
  const origins = new Map(wiring.origins.map(({ entry, origin }) => [entry, origin]));
  const generated = wiring.generated;
  return [
    ...renameRows('type', wiring.renames.types, generated?.renames.types ?? [], origins),
    ...renameRows('field', wiring.renames.fields, generated?.renames.fields ?? [], origins),
    ...mergeKeyRows(wiring.mergeKeys, generated?.mergeKeys ?? [], origins),
  ];
}

/**
 * Starts the override form from what a source is served with now.
 *
 * @param wiring - The source's effective wiring, or null for a source that has none yet.
 * @returns Every effective entry as an editable row.
 */
export function draftOf(wiring: WiringParts | null): WiringDraft {
  return {
    types: (wiring?.renames.types ?? []).map(({ from, to }) => ({ from, to })),
    fields: (wiring?.renames.fields ?? []).map(({ from, to }) => ({ from, to })),
    mergeKeys: (wiring?.mergeKeys ?? []).map((mergeKey) => ({
      type: mergeKey.type,
      keyField: mergeKey.keyField,
      lookupField: mergeKey.lookupField,
      keyArg: mergeKey.keyArg ?? '',
    })),
  };
}

/**
 * Trims a draft and drops the rows left wholly blank.
 *
 * @param draft - As the form holds it.
 * @returns The rows that say something.
 */
function cleanDraft(draft: WiringDraft): WiringDraft {
  const cleanRenames = (renames: readonly RenameDraft[]) =>
    renames
      .map((rename) => ({ from: rename.from.trim(), to: rename.to.trim() }))
      .filter((rename) => rename.from !== '' || rename.to !== '');
  return {
    types: cleanRenames(draft.types),
    fields: cleanRenames(draft.fields),
    mergeKeys: draft.mergeKeys
      .map((mergeKey) => ({
        type: mergeKey.type.trim(),
        keyField: mergeKey.keyField.trim(),
        lookupField: mergeKey.lookupField.trim(),
        keyArg: mergeKey.keyArg.trim(),
      }))
      .filter((mergeKey) => `${mergeKey.type}${mergeKey.keyField}${mergeKey.lookupField}${mergeKey.keyArg}` !== ''),
  };
}

/**
 * Finds the values that occur more than once.
 *
 * @param values - Any strings.
 * @returns Each repeated value once.
 */
function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/**
 * Checks a draft for what the form can tell before the server does: half-filled rows and entries given twice. The
 * server checks the names themselves.
 *
 * @param draft - As the form holds it.
 * @returns One sentence per problem; empty when the draft can be sent.
 */
export function draftProblems(draft: WiringDraft): string[] {
  const clean = cleanDraft(draft);
  const problems: string[] = [];
  const halfRename = (rename: RenameDraft) => rename.from === '' || rename.to === '';
  if (clean.types.some(halfRename)) {
    problems.push('Give every type rename both a source name and a unified name.');
  }
  if (clean.fields.some(halfRename)) {
    problems.push('Give every field rename both a source coordinate (Type.field) and a unified name.');
  }
  const isHalfKey = clean.mergeKeys.some(
    (mergeKey) => mergeKey.type === '' || mergeKey.keyField === '' || mergeKey.lookupField === '',
  );
  if (isHalfKey) {
    problems.push('Give every merge key a type, a key field and a lookup field.');
  }
  for (const from of duplicates(clean.types.map((rename) => rename.from))) {
    problems.push(`The type ${from} is renamed more than once.`);
  }
  for (const from of duplicates(clean.fields.map((rename) => rename.from))) {
    problems.push(`The field ${from} is renamed more than once.`);
  }
  for (const type of duplicates(clean.mergeKeys.map((mergeKey) => mergeKey.type))) {
    problems.push(`The type ${type} has more than one merge key.`);
  }
  return problems;
}

/**
 * Works out the rename override that turns generated renames into the drafted ones.
 *
 * @param generated - The generated renames.
 * @param drafted - The renames the user wants, trimmed.
 * @returns Each rename the user added or changed, and null for each generated one they removed.
 */
function renameOverride(generated: readonly Rename[], drafted: readonly RenameDraft[]): Record<string, string | null> {
  const generatedByFrom = new Map(generated.map((rename) => [rename.from, rename.to]));
  const draftedFroms = new Set(drafted.map((rename) => rename.from));
  const override: Record<string, string | null> = {};
  for (const rename of drafted) {
    const isUnchanged = generatedByFrom.get(rename.from) === rename.to;
    if (isUnchanged === false) {
      override[rename.from] = rename.to;
    }
  }
  for (const from of generatedByFrom.keys()) {
    if (draftedFroms.has(from) === false) {
      override[from] = null;
    }
  }
  return override;
}

/**
 * Keeps the members of a stored override this app does not write, so saving from the form does not drop them.
 *
 * @param previous - The stored override, if any.
 * @returns Its unknown members.
 */
function unknownMembersOf(previous: unknown): Record<string, unknown> {
  if (typeof previous !== 'object' || previous === null || Array.isArray(previous)) {
    return {};
  }
  return Object.fromEntries(Object.entries(previous).filter(([key]) => OVERRIDE_KEYS.has(key) === false));
}

/**
 * Builds the smallest override that turns a source's generated wiring into the drafted one: entries the draft
 * leaves as generated are left out, changed and added ones are set, and generated ones the draft removes are
 * removed.
 *
 * @param source - The source's name.
 * @param generated - Its generated wiring, or null when nothing generates any.
 * @param draft - What the form holds; check it with draftProblems first.
 * @param previous - The stored override, whose unknown members are kept.
 * @returns The override to store.
 */
export function overrideFromDraft(
  source: string,
  generated: WiringParts | null,
  draft: WiringDraft,
  previous: unknown,
): WiringOverrideInput {
  const clean = cleanDraft(draft);
  const types = renameOverride(generated?.renames.types ?? [], clean.types);
  const fields = renameOverride(generated?.renames.fields ?? [], clean.fields);
  const generatedKeys = generated?.mergeKeys ?? [];
  const generatedByType = new Map(generatedKeys.map((mergeKey) => [mergeKey.type, mergeKey]));
  const draftedTypes = new Set(clean.mergeKeys.map((mergeKey) => mergeKey.type));
  const mergeKeys = clean.mergeKeys
    .map(
      (mergeKey): MergeKey => ({
        type: mergeKey.type,
        keyField: mergeKey.keyField,
        lookupField: mergeKey.lookupField,
        ...(mergeKey.keyArg === '' ? {} : { keyArg: mergeKey.keyArg }),
      }),
    )
    .filter((mergeKey) => {
      const generatedKey = generatedByType.get(mergeKey.type);
      return generatedKey === undefined || sameMergeKey(generatedKey, mergeKey) === false;
    });
  const removeMergeKeys = generatedKeys
    .map((mergeKey) => mergeKey.type)
    .filter((type) => draftedTypes.has(type) === false);

  const renames: NonNullable<WiringOverrideInput['renames']> = {
    ...(Object.keys(types).length === 0 ? {} : { types }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
  };
  return {
    ...unknownMembersOf(previous),
    upstream: source,
    ...(Object.keys(renames).length === 0 ? {} : { renames }),
    ...(mergeKeys.length === 0 ? {} : { mergeKeys }),
    ...(removeMergeKeys.length === 0 ? {} : { removeMergeKeys }),
  };
}
