// Wiring: the renames and merge keys that line each source up with the unified entities before composition.
// Concepts generate it (a member's fetch document says which type is the entity, which aliases rename its fields,
// and which root field looks it up by id). Users can define wiring for any upstream, and edit the generated
// wiring, through overrides stored beside it: the effective wiring is the generated one with the overrides applied.
import {
  type ArgumentNode,
  type DocumentNode,
  type FieldNode,
  type GraphQLField,
  type GraphQLObjectType,
  type GraphQLSchema,
  getNullableType,
  isListType,
  isObjectType,
  Kind,
  type OperationDefinitionNode,
  parse,
  type SelectionSetNode,
  validate,
  visit,
} from 'graphql';
import { z } from 'zod';
import { type Concept, type ConceptMember, lowerFirst, memberArgumentName } from '../concepts/concept.ts';
import { errorMessage } from '../core/errors.ts';
import type { MergeKey, Source, SourceRenames } from './sources.ts';

/** The name the generated concept subgraph is composed under. Upstream names may not use it. */
export const CONCEPT_SOURCE_NAME = 'symphony_concepts';

/** The id field every concept's entity is merged on, in every source. */
export const CONCEPT_ID_FIELD = 'id';

/** The variable a fetch document binds the entity's id to: `$id`. */
export const CONCEPT_ID_VARIABLE = 'id';

/** One source's wiring. */
export interface SourceWiring {
  /** The upstream's name, or CONCEPT_SOURCE_NAME. */
  upstream: string;
  renames: Required<SourceRenames>;
  mergeKeys: MergeKey[];
}

/**
 * A user's edit to one source's wiring. A rename set to null removes the generated one, and a string adds or
 * replaces one. A merge key replaces the generated key for the same type or adds one, and `removeMergeKeys` drops
 * generated keys by type.
 */
export interface WiringOverride {
  upstream: string;
  renames?: {
    types?: Readonly<Record<string, string | null>>;
    fields?: Readonly<Record<string, string | null>>;
  };
  mergeKeys?: readonly MergeKey[];
  removeMergeKeys?: readonly string[];
}

/** Where one effective entry came from. */
export type WiringOrigin = 'generated' | 'override';

/** A source's wiring as served, with what produced it. */
export interface EffectiveWiring extends SourceWiring {
  /** Null when no concept generates wiring for this source. */
  generated: SourceWiring | null;
  /** Null when the user has not edited this source's wiring. */
  override: WiringOverride | null;
  /** Origin per entry: keys are `type:<Source>`, `field:<Source.field>` and `key:<Type>`. */
  origins: Readonly<Record<string, WiringOrigin>>;
}

/** Something that stops a concept's wiring from being generated, or two concepts' wiring from agreeing. */
export interface WiringProblem {
  upstream: string;
  /** The concept whose member produced it, when one did. */
  concept: string | null;
  message: string;
}

/** The generated wiring for a set of concepts, including the concept subgraph's own. */
export interface DerivedWiring {
  wiring: SourceWiring[];
  problems: WiringProblem[];
}

/** A GraphQL name: letters, digits and underscores, not starting with a digit. */
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** A field coordinate, `Type.field`, as field renames are keyed. */
const FIELD_COORDINATE = /^[_A-Za-z][_0-9A-Za-z]*\.[_A-Za-z][_0-9A-Za-z]*$/;

/** The document nodes that make a fetch's selection depend on fragments, which the derivation does not follow. */
const FRAGMENT_KINDS: readonly Kind[] = [Kind.FRAGMENT_DEFINITION, Kind.FRAGMENT_SPREAD, Kind.INLINE_FRAGMENT];

/** The prefix GraphQL reserves for introspection names, which cannot be renamed. */
const INTROSPECTION_PREFIX = '__';

const graphqlName = z
  .string()
  .regex(GRAPHQL_NAME, 'Use a GraphQL name: letters, digits and _, not starting with a digit.');

/** A merge key, as a user writes it. */
export const mergeKeySchema = z.object({
  type: graphqlName,
  keyField: graphqlName,
  lookupField: graphqlName,
  keyArg: graphqlName.optional(),
});

/** A user's wiring override, as the service accepts it. */
export const wiringOverrideSchema = z.object({
  upstream: z.string().min(1),
  renames: z
    .object({
      types: z.record(graphqlName, graphqlName.nullable()).optional(),
      fields: z
        .record(
          z.string().regex(FIELD_COORDINATE, 'Key a field rename by its source coordinate, Type.field.'),
          graphqlName.nullable(),
        )
        .optional(),
    })
    .optional(),
  mergeKeys: z
    .array(mergeKeySchema)
    .refine(
      (mergeKeys) => new Set(mergeKeys.map((mergeKey) => mergeKey.type)).size === mergeKeys.length,
      'Give each type at most one merge key.',
    )
    .optional(),
  removeMergeKeys: z.array(graphqlName).optional(),
}) satisfies z.ZodType<WiringOverride>;

/** What one member, or the concept subgraph for one concept, adds to its source's wiring. */
interface Contribution {
  upstream: string;
  concept: string;
  types: Record<string, string>;
  fields: Record<string, string>;
  mergeKey: MergeKey;
}

/** One source's wiring while contributions are merged into it. */
interface WiringDraft {
  types: Map<string, string>;
  fields: Map<string, string>;
  mergeKeys: Map<string, MergeKey>;
}

/** Why a member's fetch document yields no wiring. The derivation's helpers return it in place of their result. */
class Refusal {
  readonly message: string;

  /**
   * @param message - What stops the derivation, worded for the person who wrote the concept.
   */
  constructor(message: string) {
    this.message = message;
  }
}

/**
 * Checks a fetch document for syntax the derivation cannot map: fragments and directives.
 *
 * @param document - The parsed fetch document.
 * @returns Why it cannot be used, or null.
 */
function unsupportedSyntax(document: DocumentNode): Refusal | null {
  const kinds = new Set<Kind>();
  visit(document, {
    enter: (node) => {
      kinds.add(node.kind);
    },
  });
  const usesFragments = FRAGMENT_KINDS.some((kind) => kinds.has(kind));
  if (usesFragments) {
    return new Refusal('The fetch document uses fragments; select the entity fields directly so they can be mapped.');
  }
  if (kinds.has(Kind.DIRECTIVE)) {
    return new Refusal('The fetch document uses directives; a conditional selection cannot be mapped to the entity.');
  }
  return null;
}

/**
 * Finds the fetch document's one query operation.
 *
 * @param document - The parsed fetch document, free of fragments.
 * @returns The operation, or why there is not exactly one query.
 */
function singleQuery(document: DocumentNode): OperationDefinitionNode | Refusal {
  const [operation, ...rest] = document.definitions;
  const isSingleQuery =
    rest.length === 0 && operation?.kind === Kind.OPERATION_DEFINITION && operation.operation === 'query';
  if (isSingleQuery) {
    return operation;
  }
  return new Refusal('The fetch document must hold exactly one query operation.');
}

/**
 * Lists a selection set's fields. The document is free of fragments, so every selection is a field.
 *
 * @param selectionSet - Any selection set.
 * @returns Its fields.
 */
function fieldsOf(selectionSet: SelectionSetNode | undefined): FieldNode[] {
  return (selectionSet?.selections ?? []).filter((selection): selection is FieldNode => selection.kind === Kind.FIELD);
}

/**
 * Lists every field below a selection set, at any depth.
 *
 * @param selectionSet - A field's selection set, if it has one.
 * @returns The nested fields.
 */
function fieldsDeepOf(selectionSet: SelectionSetNode | undefined): FieldNode[] {
  return fieldsOf(selectionSet).flatMap((field) => [field, ...fieldsDeepOf(field.selectionSet)]);
}

/**
 * Parses a member's fetch document and checks it against its upstream's schema.
 *
 * @param member - The member.
 * @param schema - Its upstream's schema.
 * @returns The root field selection, or why the document cannot be used.
 */
function fetchRootOf(member: ConceptMember, schema: GraphQLSchema): FieldNode | Refusal {
  let document: DocumentNode;
  try {
    document = parse(member.documents.fetch);
  } catch (error) {
    return new Refusal(`The fetch document does not parse: ${errorMessage(error)}`);
  }
  const unsupported = unsupportedSyntax(document);
  if (unsupported !== null) {
    return unsupported;
  }
  const operation = singleQuery(document);
  if (operation instanceof Refusal) {
    return operation;
  }
  const errors = validate(schema, document);
  if (errors.length > 0) {
    const reasons = errors.map((error) => error.message).join(' ');
    return new Refusal(`The fetch document does not validate against ${member.upstream}: ${reasons}`);
  }
  const [root, ...others] = fieldsOf(operation.selectionSet);
  if (root === undefined || others.length > 0) {
    return new Refusal('The fetch query must select exactly one root field.');
  }
  return root;
}

/**
 * Finds the entity type a root field returns: its type without non-null, which must be an object, not a list.
 *
 * @param field - The root field's definition.
 * @returns The entity type, or why the field does not return one entity.
 */
function entityTypeOf(field: GraphQLField<unknown, unknown>): GraphQLObjectType | Refusal {
  const nullable = getNullableType(field.type);
  if (isListType(nullable)) {
    return new Refusal(`Query.${field.name} returns a list; the fetch must look up one entity by id.`);
  }
  if (isObjectType(nullable)) {
    return nullable;
  }
  return new Refusal(`Query.${field.name} returns ${String(nullable)}, which is not an object type.`);
}

/**
 * Tells whether an argument takes the `$id` variable.
 *
 * @param argument - A root field argument.
 * @returns True when its value is `$id`.
 */
function isBoundToId(argument: ArgumentNode): boolean {
  return argument.value.kind === Kind.VARIABLE && argument.value.name.value === CONCEPT_ID_VARIABLE;
}

/**
 * Finds the root field argument the fetch binds `$id` to, which the merge key looks the entity up through.
 *
 * @param root - The root field selection.
 * @returns The argument's name, or why the lookup is not by `$id` alone.
 */
function idArgumentOf(root: FieldNode): string | Refusal {
  const rootName = root.name.value;
  const unbound = (root.arguments ?? []).find((argument) => isBoundToId(argument) === false);
  if (unbound !== undefined) {
    return new Refusal(
      `The argument "${unbound.name.value}" of ${rootName} is not bound to $${CONCEPT_ID_VARIABLE}; a lookup by id may take only that.`,
    );
  }
  const [idArgument, ...others] = root.arguments ?? [];
  if (idArgument === undefined) {
    return new Refusal(`${rootName} takes no argument bound to $${CONCEPT_ID_VARIABLE}, so it cannot look up by id.`);
  }
  if (others.length > 0) {
    return new Refusal(`${rootName} binds $${CONCEPT_ID_VARIABLE} to more than one argument.`);
  }
  return idArgument.name.value;
}

/**
 * Turns the aliases in the entity's top-level selection into field renames on the entity type.
 *
 * @param entityType - The entity type in the member's upstream.
 * @param selections - The root field's top-level field selections.
 * @returns The renames by `Type.field`, or why an alias cannot be mapped.
 */
function aliasRenames(entityType: GraphQLObjectType, selections: FieldNode[]): Record<string, string> | Refusal {
  const renames: Record<string, string> = {};
  for (const selection of selections) {
    const field = selection.name.value;
    const hasNestedAlias = fieldsDeepOf(selection.selectionSet).some((nested) => nested.alias !== undefined);
    if (hasNestedAlias) {
      return new Refusal(
        `The selection of ${field} has aliases inside it; only the entity's own fields can be renamed.`,
      );
    }
    const alias = selection.alias?.value ?? field;
    if (alias === field) {
      continue;
    }
    if (field.startsWith(INTROSPECTION_PREFIX)) {
      return new Refusal(`${field} is an introspection field and cannot be renamed to ${alias}.`);
    }
    const coordinate = `${entityType.name}.${field}`;
    const aliasIsTaken = entityType.getFields()[alias] !== undefined;
    if (aliasIsTaken) {
      return new Refusal(
        `${coordinate} is aliased to ${alias}, but ${entityType.name} already has a field by that name.`,
      );
    }
    const earlier = renames[coordinate];
    if (earlier !== undefined && earlier !== alias) {
      return new Refusal(`${coordinate} is selected under two aliases, ${earlier} and ${alias}.`);
    }
    renames[coordinate] = alias;
  }
  return renames;
}

/**
 * Derives what one member adds to its upstream's wiring.
 *
 * @param concept - The concept.
 * @param member - One of its members.
 * @param schemas - Upstream schemas by name.
 * @returns The member's contribution, or why it has none.
 */
function deriveMemberWiring(
  concept: Concept,
  member: ConceptMember,
  schemas: ReadonlyMap<string, GraphQLSchema>,
): Contribution | Refusal {
  const { upstream } = member;
  if (upstream === CONCEPT_SOURCE_NAME) {
    return new Refusal(`The upstream name "${CONCEPT_SOURCE_NAME}" is reserved for the concept subgraph.`);
  }
  const schema = schemas.get(upstream);
  if (schema === undefined) {
    return new Refusal(`No schema is cached for "${upstream}"; refresh the upstream first.`);
  }
  const root = fetchRootOf(member, schema);
  if (root instanceof Refusal) {
    return root;
  }
  const queryFields = schema.getQueryType()?.getFields() ?? {};
  const rootField = queryFields[root.name.value];
  if (rootField === undefined) {
    return new Refusal(`${root.name.value} is not a field of Query.`);
  }
  const entityType = entityTypeOf(rootField);
  if (entityType instanceof Refusal) {
    return entityType;
  }
  const idArgument = idArgumentOf(root);
  if (idArgument instanceof Refusal) {
    return idArgument;
  }
  const selections = fieldsOf(root.selectionSet);
  const selectsId = selections.some((field) => (field.alias?.value ?? field.name.value) === CONCEPT_ID_FIELD);
  if (selectsId === false) {
    return new Refusal(
      `The fetch must select the entity's ${CONCEPT_ID_FIELD}, as ${CONCEPT_ID_FIELD} or aliased to it.`,
    );
  }
  const fields = aliasRenames(entityType, selections);
  if (fields instanceof Refusal) {
    return fields;
  }
  const types: Record<string, string> = {};
  if (entityType.name !== concept.name) {
    const nameIsTaken = schema.getType(concept.name) !== undefined;
    if (nameIsTaken) {
      return new Refusal(`${upstream} already has a type named ${concept.name}, so ${entityType.name} cannot take it.`);
    }
    types[entityType.name] = concept.name;
  }
  const lookupField = `${memberArgumentName(upstream)}${concept.name}`;
  if (rootField.name !== lookupField) {
    const lookupIsTaken = queryFields[lookupField] !== undefined;
    if (lookupIsTaken) {
      return new Refusal(`${upstream} already has Query.${lookupField}, so Query.${rootField.name} cannot take it.`);
    }
    fields[`Query.${rootField.name}`] = lookupField;
  }
  const mergeKey = idMergeKey(concept.name, lookupField, idArgument);
  return { upstream, concept: concept.name, types, fields, mergeKey };
}

/**
 * @returns The merge key, without keyArg when the argument is named like the id field.
 */
function idMergeKey(type: string, lookupField: string, keyArg: string): MergeKey {
  const base = { type, keyField: CONCEPT_ID_FIELD, lookupField };
  return keyArg === CONCEPT_ID_FIELD ? base : { ...base, keyArg };
}

/**
 * Tells whether two merge keys say the same thing.
 *
 * @param a - One merge key.
 * @param b - Another.
 * @returns True when every field matches.
 */
function sameMergeKey(a: MergeKey, b: MergeKey): boolean {
  return a.type === b.type && a.keyField === b.keyField && a.lookupField === b.lookupField && a.keyArg === b.keyArg;
}

/**
 * Finds where a contribution disagrees with the wiring merged so far for its source.
 *
 * @param draft - The source's wiring so far.
 * @param contribution - What one more member or concept adds.
 * @returns One message per disagreement.
 */
function conflictsOf(draft: WiringDraft, contribution: Contribution): string[] {
  const conflicts: string[] = [];
  for (const [from, to] of Object.entries(contribution.types)) {
    const earlier = draft.types.get(from);
    if (earlier !== undefined && earlier !== to) {
      conflicts.push(`The type ${from} is renamed to both ${earlier} and ${to}.`);
    }
    const claimant = [...draft.types].find(([source, target]) => target === to && source !== from)?.[0];
    if (claimant !== undefined) {
      conflicts.push(`Both ${claimant} and ${from} are renamed to ${to}.`);
    }
  }
  for (const [from, to] of Object.entries(contribution.fields)) {
    const earlier = draft.fields.get(from);
    if (earlier !== undefined && earlier !== to) {
      conflicts.push(`The field ${from} is renamed to both ${earlier} and ${to}.`);
    }
    const typeName = from.split('.')[0];
    const claimant = [...draft.fields].find(
      ([source, target]) => target === to && source !== from && source.split('.')[0] === typeName,
    )?.[0];
    if (claimant !== undefined) {
      conflicts.push(`Both ${claimant} and ${from} are renamed to ${to}.`);
    }
  }
  const { mergeKey } = contribution;
  const earlierKey = draft.mergeKeys.get(mergeKey.type);
  if (earlierKey !== undefined && sameMergeKey(earlierKey, mergeKey) === false) {
    conflicts.push(
      `The type ${mergeKey.type} has two merge keys, through ${earlierKey.lookupField} and ${mergeKey.lookupField}.`,
    );
  }
  return conflicts;
}

/**
 * Builds what the concept subgraph adds for one concept: its `Query.<name>(id:)` lookup as the merge key.
 *
 * @param concept - The concept.
 * @returns The contribution, which renames nothing.
 */
function conceptSubgraphContribution(concept: Concept): Contribution {
  return {
    upstream: CONCEPT_SOURCE_NAME,
    concept: concept.name,
    types: {},
    fields: {},
    mergeKey: idMergeKey(concept.name, lowerFirst(concept.name), CONCEPT_ID_FIELD),
  };
}

/**
 * Generates the wiring that merges every concept's members into one entity per concept.
 *
 * @param concepts - Parsed concepts.
 * @param schemas - Each member upstream's cached schema, by upstream name.
 * @returns One wiring per upstream any concept uses, plus the concept subgraph's, sorted by upstream name, and what
 *   could not be derived. A member with a problem contributes nothing; its upstream's wiring may then be empty.
 */
export function deriveWiring(concepts: readonly Concept[], schemas: ReadonlyMap<string, GraphQLSchema>): DerivedWiring {
  const drafts = new Map<string, WiringDraft>();
  const problems: WiringProblem[] = [];
  const draftFor = (upstream: string): WiringDraft => {
    const existing = drafts.get(upstream);
    if (existing !== undefined) {
      return existing;
    }
    const draft: WiringDraft = { types: new Map(), fields: new Map(), mergeKeys: new Map() };
    drafts.set(upstream, draft);
    return draft;
  };
  const merge = (contribution: Contribution): void => {
    const draft = draftFor(contribution.upstream);
    const conflicts = conflictsOf(draft, contribution);
    for (const message of conflicts) {
      problems.push({ upstream: contribution.upstream, concept: contribution.concept, message });
    }
    if (conflicts.length > 0) {
      return;
    }
    for (const [from, to] of Object.entries(contribution.types)) {
      draft.types.set(from, to);
    }
    for (const [from, to] of Object.entries(contribution.fields)) {
      draft.fields.set(from, to);
    }
    draft.mergeKeys.set(contribution.mergeKey.type, contribution.mergeKey);
  };
  for (const concept of concepts) {
    for (const member of concept.members) {
      const derivation = deriveMemberWiring(concept, member, schemas);
      if (derivation instanceof Refusal) {
        problems.push({ upstream: member.upstream, concept: concept.name, message: derivation.message });
      } else {
        merge(derivation);
      }
    }
  }
  for (const concept of concepts) {
    merge(conceptSubgraphContribution(concept));
  }
  for (const member of concepts.flatMap((concept) => concept.members)) {
    // A member whose wiring failed still gets its (possibly empty) wiring, so every member upstream is listed.
    draftFor(member.upstream);
  }
  const wiring = [...drafts]
    .map(([upstream, draft]) => ({
      upstream,
      renames: { types: Object.fromEntries(draft.types), fields: Object.fromEntries(draft.fields) },
      mergeKeys: [...draft.mergeKeys.values()],
    }))
    .sort((a, b) => compareNames(a.upstream, b.upstream));
  return { wiring, problems };
}

/**
 * Orders two names by code point, the same on every machine.
 *
 * @param a - One name.
 * @param b - Another.
 * @returns Negative, zero or positive, as `Array.prototype.sort` expects.
 */
function compareNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Applies one rename override map to generated renames, recording each entry's origin.
 *
 * @param generated - The generated renames.
 * @param override - The user's renames: null removes an entry, a string adds or replaces it.
 * @param originPrefix - `type:` or `field:`.
 * @param origins - Filled with the origin of every effective entry.
 * @returns The effective renames.
 */
function applyRenameOverrides(
  generated: Readonly<Record<string, string>>,
  override: Readonly<Record<string, string | null>> | undefined,
  originPrefix: string,
  origins: Record<string, WiringOrigin>,
): Record<string, string> {
  const effective = new Map(Object.entries(generated));
  for (const from of effective.keys()) {
    origins[`${originPrefix}${from}`] = 'generated';
  }
  for (const [from, to] of Object.entries(override ?? {})) {
    if (to === null) {
      effective.delete(from);
      delete origins[`${originPrefix}${from}`];
    } else {
      effective.set(from, to);
      origins[`${originPrefix}${from}`] = 'override';
    }
  }
  return Object.fromEntries(effective);
}

/**
 * Applies an override's merge keys to the generated ones, recording each key's origin.
 *
 * @param generated - The generated merge keys.
 * @param override - The user's override, if any.
 * @param origins - Filled with the origin of every effective key.
 * @returns The effective merge keys: generated keys first, in order, then added ones.
 */
function applyMergeKeyOverrides(
  generated: readonly MergeKey[],
  override: WiringOverride | null,
  origins: Record<string, WiringOrigin>,
): MergeKey[] {
  const removed = new Set(override?.removeMergeKeys ?? []);
  const effective = new Map<string, MergeKey>();
  for (const mergeKey of generated) {
    const isRemoved = removed.has(mergeKey.type);
    if (isRemoved === false) {
      effective.set(mergeKey.type, mergeKey);
      origins[`key:${mergeKey.type}`] = 'generated';
    }
  }
  for (const mergeKey of override?.mergeKeys ?? []) {
    effective.set(mergeKey.type, mergeKey);
    origins[`key:${mergeKey.type}`] = 'override';
  }
  return [...effective.values()];
}

/**
 * Applies one source's override, if any, to its generated wiring, if any.
 *
 * @param upstream - The source's name.
 * @param generated - Its generated wiring, or null.
 * @param override - The user's override, or null.
 * @returns The effective wiring.
 */
function effectiveWiringOf(
  upstream: string,
  generated: SourceWiring | null,
  override: WiringOverride | null,
): EffectiveWiring {
  const origins: Record<string, WiringOrigin> = {};
  const types = applyRenameOverrides(generated?.renames.types ?? {}, override?.renames?.types, 'type:', origins);
  const fields = applyRenameOverrides(generated?.renames.fields ?? {}, override?.renames?.fields, 'field:', origins);
  const mergeKeys = applyMergeKeyOverrides(generated?.mergeKeys ?? [], override, origins);
  return { upstream, renames: { types, fields }, mergeKeys, generated, override, origins };
}

/**
 * Applies users' overrides to the generated wiring. An override for an upstream no concept uses defines its
 * wiring from nothing.
 *
 * @param generated - From deriveWiring.
 * @param overrides - As stored, at most one per upstream.
 * @returns The effective wiring, one per upstream that has generated wiring or an override, sorted by upstream name.
 * @throws When two overrides name the same upstream, which the store should not allow.
 */
export function applyWiringOverrides(
  generated: readonly SourceWiring[],
  overrides: readonly WiringOverride[],
): EffectiveWiring[] {
  const overridesByUpstream = new Map<string, WiringOverride>();
  for (const override of overrides) {
    if (overridesByUpstream.has(override.upstream)) {
      throw new Error(`Two wiring overrides name "${override.upstream}"; store at most one per upstream.`);
    }
    overridesByUpstream.set(override.upstream, override);
  }
  const generatedByUpstream = new Map(generated.map((wiring) => [wiring.upstream, wiring]));
  const upstreams = [...new Set([...generatedByUpstream.keys(), ...overridesByUpstream.keys()])].sort(compareNames);
  return upstreams.map((upstream) =>
    effectiveWiringOf(upstream, generatedByUpstream.get(upstream) ?? null, overridesByUpstream.get(upstream) ?? null),
  );
}

/**
 * Turns a source's wiring into the fields a `Source` carries it in.
 *
 * @param wiring - Generated or effective wiring.
 * @returns The `renames` and `mergeKeys` to spread into the source.
 */
export function sourceWiringFields(wiring: SourceWiring): Required<Pick<Source, 'renames' | 'mergeKeys'>> {
  return {
    renames: { types: { ...wiring.renames.types }, fields: { ...wiring.renames.fields } },
    mergeKeys: [...wiring.mergeKeys],
  };
}
