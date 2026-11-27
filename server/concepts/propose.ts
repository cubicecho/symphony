// Drafts concepts from signals in the upstreams' cached schemas, for an agent or a person to refine and submit.
//
// - Object types in two or more upstreams whose names match once a prefix or suffix is removed (`AcmeWidget` and
//   `Widget`, case-insensitive) are one candidate concept, named after what they share.
// - A member needs `id: ID!` on its type and a Query field taking `id: ID!` that returns it: that field is its
//   fetch. Types without both are reported as not ready.
// - A field every member has with one built-in scalar type is shared; a field only some members have is owned.
// - `createX`, `updateX` and `deleteX` become the member's write documents when their arguments map onto the
//   concept's fields by name; otherwise the document is left out, with why.
// Every decision comes with a plain-language reason and how sure the proposer is of it. Drafts are not checked
// here: the proposal service runs each through the concept validator.
import {
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  getNamedType,
  getNullableType,
  isInputObjectType,
  isIntrospectionType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  specifiedScalarTypes,
} from 'graphql';
import { PROPOSAL_DEFAULTS, type ProposalSettings } from '../core/defaults.ts';
import { type ConceptField, ConceptOperation, FieldMode, ID_FIELD, ID_VARIABLE } from './concept.ts';

/** How sure the proposer is of one decision. */
export const Confidence = {
  /** The schemas say so outright: the same name, the same type. */
  High: 'high',
  /** A good guess a person should glance at: names that match only once a prefix is removed. */
  Medium: 'medium',
  /** A fallback that probably needs changing by hand. */
  Low: 'low',
} as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

/** Why the proposer decided one thing. */
export interface ProposalReason {
  /** What the decision is about: the concept, `field title`, `member shop`, `shop create`. */
  about: string;
  reason: string;
  confidence: Confidence;
}

/** A member as drafted: a document is left out when it could not be written with confidence. */
export interface DraftMember {
  upstream: string;
  documents: Partial<Record<ConceptOperation, string>>;
}

/** A concept definition as drafted. It is a full definition once every member has all four documents. */
export interface DraftDefinition {
  name: string;
  fields: ConceptField[];
  members: DraftMember[];
}

/** One drafted concept and the reasons behind it. */
export interface ConceptDraft {
  definition: DraftDefinition;
  reasons: ProposalReason[];
}

/** A type that looks like part of a shared entity but can't be a member yet. */
export interface NotReadyType {
  upstream: string;
  type: string;
  reason: string;
}

/** A candidate concept with fewer than two members that are ready. */
export interface NotReadyConcept {
  name: string;
  types: NotReadyType[];
}

/** What the proposer found. */
export interface ConceptProposals {
  drafts: ConceptDraft[];
  notReady: NotReadyConcept[];
}

/** One object type in one upstream. */
interface TypeRef {
  upstream: string;
  schema: GraphQLSchema;
  type: GraphQLObjectType;
}

/** Object types in several upstreams that share a name once a prefix or suffix is removed. */
interface Candidate {
  name: string;
  /** The shared name, lower-cased: what the types were matched on. */
  key: string;
  /** One type per upstream. */
  matches: TypeRef[];
  /** How many of them are called exactly the candidate's name. */
  exactCount: number;
}

/** A member type that has an id and a lookup by it. */
interface ReadyMember extends TypeRef {
  lookup: GraphQLField<unknown, unknown>;
}

/** One value a mutation takes: an argument, or a field of an input object argument. */
interface Slot {
  /** `name`, or `input.name`. */
  path: string;
  argument: string;
  /** Set when the slot is a field of the argument's input object. */
  inputField: string | null;
  name: string;
  type: GraphQLInputType;
  isRequired: boolean;
}

/** A member write document, or why it was left out. */
type DraftDocument = { text: string; reason: ProposalReason } | { text: null; reason: ProposalReason };

/** The three write documents, and the verb their mutation's name starts with. */
const WRITE_VERBS: ReadonlyArray<readonly [ConceptOperation, string]> = [
  [ConceptOperation.Create, 'create'],
  [ConceptOperation.Update, 'update'],
  [ConceptOperation.Delete, 'delete'],
];

/** The verbs of the mutations the concept subgraph generates for each concept (generate.ts conceptNames). */
const GENERATED_MUTATION_VERBS = ['create', 'update', 'attach', 'delete'];

/** The scalars every schema has: a shared field must be one of these in every member. */
const BUILT_IN_SCALARS = new Set(specifiedScalarTypes.map((scalar) => scalar.name));

/** The named types `$id` may be declared with, since a Symphony UUID travels as either. */
const ID_TYPES = new Set(['ID', 'String']);

/** The words of a PascalCase or camelCase name: `ACMEWidgetV2` is `ACME`, `Widget`, `V2`. */
const NAME_WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g;

/** What the not-ready report says a member lacks. */
const NEEDS_ID_AND_LOOKUP = `needs \`${ID_FIELD}: ID!\` and a lookup by id`;

/**
 * Lists a schema's own object types: no root types, no introspection types.
 *
 * @param schema - An upstream's schema.
 * @returns The object types, in type-map order.
 */
function objectTypesOf(schema: GraphQLSchema): GraphQLObjectType[] {
  const roots = new Set([schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]);
  return Object.values(schema.getTypeMap()).filter(
    (type): type is GraphQLObjectType =>
      isObjectType(type) && isIntrospectionType(type) === false && roots.has(type) === false,
  );
}

/**
 * Upper-cases a name's first letter.
 *
 * @param name - Any name.
 * @returns The name, starting with a capital.
 */
function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Lists the names a type name leaves once a prefix or a suffix is removed, at word boundaries, itself included.
 *
 * @param typeName - A type name, such as `AcmeWidget`.
 * @returns The names, such as `AcmeWidget`, `Widget` and `Acme`.
 */
function sharedNamesOf(typeName: string): string[] {
  const words = typeName.match(NAME_WORD) ?? [];
  const names = [typeName];
  for (let cut = 1; cut < words.length; cut += 1) {
    names.push(words.slice(cut).join(''), words.slice(0, cut).join(''));
  }
  return names.map(capitalize);
}

/**
 * Picks, from one upstream's types that match a shared name, the one most likely to be the entity.
 *
 * @param key - The shared name, lower-cased.
 * @param refs - One upstream's matching types.
 * @returns The exact match, else the shortest name.
 */
function bestMatch(key: string, refs: TypeRef[]): TypeRef | undefined {
  const exact = refs.find((ref) => ref.type.name.toLowerCase() === key);
  return exact ?? [...refs].sort((a, b) => a.type.name.length - b.type.name.length)[0];
}

/**
 * Finds the candidate concepts: types in two or more upstreams that share a name. Each type joins one candidate
 * at most, the widest and most exact first.
 *
 * @param refs - Every object type of every upstream.
 * @param settings - The shortest shared name.
 * @returns The candidates, in the order they were picked.
 */
function findCandidates(refs: readonly TypeRef[], settings: ProposalSettings): Candidate[] {
  const byKey = new Map<string, { name: string; refs: TypeRef[] }>();
  for (const ref of refs) {
    for (const name of sharedNamesOf(ref.type.name)) {
      const key = name.toLowerCase();
      if (key.length < settings.minSharedNameChars) {
        continue;
      }
      const entry = byKey.get(key) ?? { name, refs: [] };
      const isListed = entry.refs.includes(ref);
      if (isListed === false) {
        entry.refs.push(ref);
      }
      byKey.set(key, entry);
    }
  }
  const candidates: Candidate[] = [];
  for (const [key, entry] of byKey) {
    const upstreams = [...new Set(entry.refs.map((ref) => ref.upstream))];
    const matches = upstreams.flatMap((upstream) => {
      const best = bestMatch(
        key,
        entry.refs.filter((ref) => ref.upstream === upstream),
      );
      return best === undefined ? [] : [best];
    });
    const exactCount = matches.filter((ref) => ref.type.name.toLowerCase() === key).length;
    const exactName = matches.find((ref) => ref.type.name.toLowerCase() === key)?.type.name;
    candidates.push({ name: capitalize(exactName ?? entry.name), key, matches, exactCount });
  }
  candidates.sort(
    (a, b) =>
      b.matches.length - a.matches.length ||
      b.exactCount - a.exactCount ||
      b.key.length - a.key.length ||
      a.name.localeCompare(b.name),
  );
  const used = new Set<GraphQLObjectType>();
  const picked: Candidate[] = [];
  for (const candidate of candidates) {
    const free = candidate.matches.filter((ref) => used.has(ref.type) === false);
    if (free.length < 2) {
      continue;
    }
    for (const ref of free) {
      used.add(ref.type);
    }
    const exactCount = free.filter((ref) => ref.type.name.toLowerCase() === candidate.key).length;
    picked.push({ ...candidate, matches: free, exactCount });
  }
  return picked;
}

/**
 * Tells whether a value must be given: non-null and without a default.
 *
 * @param value - An argument or input field.
 * @returns True when leaving it out is refused.
 */
function isRequired(value: GraphQLArgument | GraphQLInputField): boolean {
  return isNonNullType(value.type) && value.defaultValue === undefined;
}

/**
 * Tells whether a type is `ID!`.
 *
 * @param type - A field's or argument's type.
 * @returns True for exactly `ID!`.
 */
function isRequiredId(type: GraphQLOutputType | GraphQLInputType): boolean {
  return isNonNullType(type) && isScalarType(type.ofType) && type.ofType.name === 'ID';
}

/**
 * Finds a Query field that looks one entity up by id: it takes `id: ID!`, needs nothing else, and returns the type.
 *
 * @param schema - The upstream's schema.
 * @param type - The entity's type.
 * @returns The lookup, preferring one with no other arguments, or undefined.
 */
function lookupOf(schema: GraphQLSchema, type: GraphQLObjectType): GraphQLField<unknown, unknown> | undefined {
  const fields = Object.values(schema.getQueryType()?.getFields() ?? {});
  const lookups = fields.filter((field) => {
    const returnsType = getNullableType(field.type) === type;
    const idArgument = field.args.find((argument) => argument.name === ID_FIELD);
    const takesId = idArgument !== undefined && isRequiredId(idArgument.type);
    const needsMore = field.args.some((argument) => argument.name !== ID_FIELD && isRequired(argument));
    return returnsType && takesId && needsMore === false;
  });
  return lookups.find((field) => field.args.length === 1) ?? lookups[0];
}

/**
 * Checks that a type can be a member: it has `id: ID!` and a lookup by it.
 *
 * @param ref - The type.
 * @returns The ready member, or what it lacks.
 */
function readinessOf(ref: TypeRef): { ready: ReadyMember } | { lacks: string } {
  const idField = ref.type.getFields()[ID_FIELD];
  const hasId = idField !== undefined && isRequiredId(idField.type);
  const lookup = lookupOf(ref.schema, ref.type);
  if (hasId && lookup !== undefined) {
    return { ready: { ...ref, lookup } };
  }
  const missing = [
    hasId ? null : `${ref.type.name} has no \`${ID_FIELD}: ID!\``,
    lookup === undefined ? `no Query field takes \`${ID_FIELD}: ID!\` and returns ${ref.type.name}` : null,
  ].filter((part) => part !== null);
  return { lacks: `Not ready: ${NEEDS_ID_AND_LOOKUP} (${missing.join('; ')}).` };
}

/**
 * Describes a field's type with every non-null dropped, which is what members must agree on to share it.
 *
 * @param type - The field's type.
 * @returns `String`, or `[String]` for a list.
 */
function shapeOf(type: GraphQLOutputType): string {
  const nullable = getNullableType(type);
  return isListType(nullable) ? `[${shapeOf(nullable.ofType)}]` : (nullable as GraphQLNamedType).name;
}

/**
 * Lists the fields of a member type that a concept can carry: leaves that take no required argument, not the id.
 *
 * @param type - The member's type.
 * @returns The carried fields by name, and the names of those left out.
 */
function leafFieldsOf(type: GraphQLObjectType): {
  leaves: Map<string, GraphQLField<unknown, unknown>>;
  skipped: string[];
} {
  const leaves = new Map<string, GraphQLField<unknown, unknown>>();
  const skipped: string[] = [];
  for (const field of Object.values(type.getFields())) {
    if (field.name === ID_FIELD) {
      continue;
    }
    const isCarried = isLeafType(getNamedType(field.type)) && field.args.some(isRequired) === false;
    if (isCarried) {
      leaves.set(field.name, field);
    } else {
      skipped.push(field.name);
    }
  }
  return { leaves, skipped };
}

/**
 * Warns that members' fields of one name and different types will not compose: the generated wiring renames every
 * member's type to the concept's, so the unified API sees one type with two definitions of the field.
 *
 * @param name - The field.
 * @param holders - The members that have it, with its type in each.
 * @returns The warning.
 */
function typeClashNote(name: string, holders: ReadonlyArray<{ member: ReadyMember; shape: string }>): string {
  const typed = holders.map((holder) => `${holder.shape} in ${holder.member.upstream}`).join(', ');
  return `Its types differ (${typed}), and the unified API won't compose while they do: rename one member's ${name} with a wiring override.`;
}

/**
 * Lists the mutations of a member's upstream that the concept's generated mutations would clash with on the
 * unified API: its own `createWidget` beside the generated `createWidget`, for instance.
 *
 * @param member - The member.
 * @param conceptName - The concept's name.
 * @returns The clashing mutation names.
 */
function generatedNameClashes(member: ReadyMember, conceptName: string): string[] {
  const mutations = member.schema.getMutationType()?.getFields() ?? {};
  return GENERATED_MUTATION_VERBS.map((verb) => `${verb}${conceptName}`).filter(
    (name) => mutations[name] !== undefined,
  );
}

/**
 * Decides each field's mode: shared when every member has it as the same built-in scalar, owned otherwise.
 *
 * @param members - The ready members.
 * @returns The fields, shared first, and a reason for each.
 */
function draftFields(members: readonly ReadyMember[]): { fields: ConceptField[]; reasons: ProposalReason[] } {
  const leavesByMember = members.map((member) => ({ member, ...leafFieldsOf(member.type) }));
  const names = [...new Set(leavesByMember.flatMap(({ leaves }) => [...leaves.keys()]))];
  const shared: ConceptField[] = [];
  const owned: ConceptField[] = [];
  const reasons: ProposalReason[] = [];
  for (const name of names) {
    const holders = leavesByMember.flatMap(({ member, leaves }) => {
      const field = leaves.get(name);
      return field === undefined ? [] : [{ member, shape: shapeOf(field.type) }];
    });
    const shapes = holders.map((holder) => holder.shape);
    const ownerName = holders[0]?.member.upstream ?? '';
    const about = `field ${name}`;
    const isEverywhere = holders.length === members.length;
    const isOneShape = new Set(shapes).size === 1;
    const namedType = shapes[0]?.replace(/[[\]]/g, '') ?? '';
    if (isEverywhere && isOneShape && BUILT_IN_SCALARS.has(namedType)) {
      shared.push({ name, mode: FieldMode.Shared });
      reasons.push({
        about,
        reason: `Every member has ${name} as ${shapes[0]}, so it is shared.`,
        confidence: Confidence.High,
      });
      continue;
    }
    owned.push({ name, mode: FieldMode.Owned, owner: ownerName });
    if (holders.length === 1) {
      reasons.push({
        about,
        reason: `Only ${ownerName} has ${name}, so ${ownerName} owns it.`,
        confidence: Confidence.High,
      });
    } else if (isEverywhere === false) {
      const others = holders.slice(1).map(({ member }) => member.upstream);
      const clash = isOneShape ? '' : ` ${typeClashNote(name, holders)}`;
      reasons.push({
        about,
        reason: `${name} is in ${ownerName} and ${others.join(', ')} but not every member, so it is drafted as owned by ${ownerName}; the others' copies are left out.${clash}`,
        confidence: Confidence.Low,
      });
    } else if (isOneShape) {
      reasons.push({
        about,
        reason: `Every member has ${name}, but as ${shapes[0]}, and only a built-in scalar can be shared; drafted as owned by ${ownerName}.`,
        confidence: Confidence.Low,
      });
    } else {
      reasons.push({
        about,
        reason: `Every member has ${name}, but not as one type, so it can't be shared; drafted as owned by ${ownerName}. ${typeClashNote(name, holders)}`,
        confidence: Confidence.Low,
      });
    }
  }
  for (const { member, skipped } of leavesByMember) {
    if (skipped.length > 0) {
      reasons.push({
        about: `member ${member.upstream}`,
        reason: `Left out ${skipped.join(', ')}: objects, lists of objects or fields that need arguments are not concept fields.`,
        confidence: Confidence.Medium,
      });
    }
  }
  return { fields: [...shared, ...owned], reasons };
}

/**
 * Names the fields one member writes: every shared field and the fields it owns.
 *
 * @param fields - The concept's fields.
 * @param upstream - The member.
 * @returns Their names.
 */
function writtenBy(fields: readonly ConceptField[], upstream: string): Set<string> {
  return new Set(
    fields.filter((field) => field.mode === FieldMode.Shared || field.owner === upstream).map((field) => field.name),
  );
}

/**
 * Writes a member's fetch: its lookup by `$id`, selecting the id and every field the member writes.
 *
 * @param member - The member.
 * @param fields - The concept's fields.
 * @returns The document.
 */
function fetchDocument(member: ReadyMember, fields: readonly ConceptField[]): string {
  const selected = [ID_FIELD, ...writtenBy(fields, member.upstream)].join(' ');
  return `query ($${ID_VARIABLE}: ID!) { ${member.lookup.name}(${ID_FIELD}: $${ID_VARIABLE}) { ${selected} } }`;
}

/**
 * Lists the values a mutation takes, one level into input objects.
 *
 * @param mutation - The mutation field.
 * @returns The slots, or why its arguments can't be read.
 */
function slotsOf(mutation: GraphQLField<unknown, unknown>): { slots: Slot[] } | { unmappable: string } {
  const slots: Slot[] = [];
  for (const argument of mutation.args) {
    const named = getNamedType(argument.type);
    const isOneInput = isInputObjectType(named) && isListType(getNullableType(argument.type)) === false;
    if (isOneInput) {
      for (const field of Object.values(named.getFields())) {
        const path = `${argument.name}.${field.name}`;
        if (isLeafType(getNamedType(field.type))) {
          slots.push({
            path,
            argument: argument.name,
            inputField: field.name,
            name: field.name,
            type: field.type,
            isRequired: isRequired(field),
          });
        } else if (isRequired(field)) {
          return { unmappable: `${path} is a required nested input, which can't be matched to a field by name` };
        }
      }
    } else if (isLeafType(named)) {
      slots.push({
        path: argument.name,
        argument: argument.name,
        inputField: null,
        name: argument.name,
        type: argument.type,
        isRequired: isRequired(argument),
      });
    } else if (isRequired(argument)) {
      return { unmappable: `${argument.name} is a required list of inputs, which can't be matched to a field by name` };
    }
  }
  return { slots };
}

/**
 * Finds the member's mutation for one write: `createWidget` for the type or the concept name, any case.
 *
 * @param member - The member.
 * @param conceptName - The concept's name.
 * @param verb - `create`, `update` or `delete`.
 * @returns The mutation, or undefined.
 */
function mutationFor(
  member: ReadyMember,
  conceptName: string,
  verb: string,
): GraphQLField<unknown, unknown> | undefined {
  const wanted = new Set([`${verb}${member.type.name}`.toLowerCase(), `${verb}${conceptName}`.toLowerCase()]);
  const mutations = Object.values(member.schema.getMutationType()?.getFields() ?? {});
  return mutations.find((field) => wanted.has(field.name.toLowerCase()));
}

/**
 * Writes the selection a write document ends with: the id when the result has one.
 *
 * @param type - The mutation's return type.
 * @returns ` { id }`, ` { __typename }`, or nothing for a scalar result.
 */
function resultSelection(type: GraphQLOutputType): string {
  const named = getNamedType(type);
  if (isLeafType(named)) {
    return '';
  }
  const hasId = isObjectType(named) && named.getFields()[ID_FIELD] !== undefined;
  return hasId ? ` { ${ID_FIELD} }` : ' { __typename }';
}

/**
 * Writes the argument list of a write from the slots it binds, nesting input-object fields.
 *
 * @param bound - The bound slots, with the variable each takes.
 * @returns `id: $id, input: { name: $name }`.
 */
function argumentText(bound: ReadonlyArray<{ slot: Slot; variable: string }>): string {
  const byArgument = new Map<string, string[]>();
  for (const { slot, variable } of bound) {
    const parts = byArgument.get(slot.argument) ?? [];
    parts.push(slot.inputField === null ? `$${variable}` : `${slot.inputField}: $${variable}`);
    byArgument.set(slot.argument, parts);
  }
  const isNested = (argument: string) =>
    bound.some(({ slot }) => slot.argument === argument && slot.inputField !== null);
  return [...byArgument]
    .map(([argument, parts]) =>
      isNested(argument) ? `${argument}: { ${parts.join(', ')} }` : `${argument}: ${parts[0]}`,
    )
    .join(', ');
}

/**
 * Drafts one write document for a member, binding `$id` and the fields the member writes by name.
 *
 * @param member - The member.
 * @param conceptName - The concept's name.
 * @param fields - The concept's fields.
 * @param operation - Which write.
 * @param verb - The verb its mutation's name starts with.
 * @returns The document, or null with why it was left out.
 */
function writeDocument(
  member: ReadyMember,
  conceptName: string,
  fields: readonly ConceptField[],
  operation: ConceptOperation,
  verb: string,
): DraftDocument {
  const about = `${member.upstream} ${operation}`;
  const mutation = mutationFor(member, conceptName, verb);
  if (mutation === undefined) {
    const reason = `No mutation called ${verb}${member.type.name} or ${verb}${conceptName}; write the ${operation} document by hand.`;
    return { text: null, reason: { about, reason, confidence: Confidence.Low } };
  }
  const leftOut = (why: string): DraftDocument => ({
    text: null,
    reason: {
      about,
      reason: `Left out: ${mutation.name} can't be mapped with confidence, since ${why}.`,
      confidence: Confidence.Low,
    },
  });
  const read = slotsOf(mutation);
  if ('unmappable' in read) {
    return leftOut(read.unmappable);
  }
  const isDelete = operation === ConceptOperation.Delete;
  const written = isDelete ? new Set<string>() : writtenBy(fields, member.upstream);
  const idSlot = read.slots.find((slot) => slot.name === ID_FIELD);
  if (idSlot === undefined) {
    return leftOut(
      `it takes no \`${ID_FIELD}\` to bind $${ID_VARIABLE} to, and the upstream must store Symphony's UUID as its id`,
    );
  }
  const idType = getNamedType(idSlot.type).name;
  if (ID_TYPES.has(idType) === false) {
    return leftOut(`its \`${idSlot.path}\` is ${idType}, but a Symphony UUID is an ID or a String`);
  }
  const bound: { slot: Slot; variable: string; declared: string }[] = [];
  const unbound: string[] = [];
  for (const slot of read.slots) {
    if (slot.name === ID_FIELD) {
      bound.push({ slot, variable: ID_VARIABLE, declared: `${idType}!` });
    } else if (written.has(slot.name)) {
      bound.push({ slot, variable: slot.name, declared: String(slot.type) });
    } else if (slot.isRequired) {
      return leftOut(`its required \`${slot.path}\` matches no field ${member.upstream} writes`);
    } else {
      unbound.push(slot.path);
    }
  }
  const sharedNames = fields.filter((field) => field.mode === FieldMode.Shared).map((field) => field.name);
  const missingShared = isDelete
    ? []
    : sharedNames.filter((name) => bound.some((one) => one.variable === name) === false);
  if (missingShared.length > 0) {
    return leftOut(
      `it takes nothing called ${missingShared.join(', ')}, and every shared field is written to every member`,
    );
  }
  // A variable bound in two places (`id` and `input.id`) is declared once, with its first place's type.
  const declarations = new Map<string, string>();
  for (const one of bound) {
    declarations.set(one.variable, declarations.get(one.variable) ?? one.declared);
  }
  const variables = [...declarations].map(([variable, declared]) => `$${variable}: ${declared}`).join(', ');
  const text = `mutation (${variables}) { ${mutation.name}(${argumentText(bound)})${resultSelection(mutation.type)} }`;
  const matched = bound.map((one) => one.slot.path).join(', ');
  const skippedNote = unbound.length === 0 ? '' : ` Optional ${unbound.join(', ')} match no field and are left out.`;
  const reason = `${mutation.name} takes ${matched}, matched to $${ID_VARIABLE} and the fields by name.${skippedNote}`;
  return { text, reason: { about, reason, confidence: unbound.length === 0 ? Confidence.High : Confidence.Medium } };
}

/**
 * Drafts one concept from a candidate whose ready members number two or more.
 *
 * @param candidate - The candidate.
 * @param members - Its ready members.
 * @param notReady - Its members that are not ready, reported in the reasons.
 * @returns The draft.
 */
function draftConcept(
  candidate: Candidate,
  members: readonly ReadyMember[],
  notReady: readonly NotReadyType[],
): ConceptDraft {
  const typeList = members.map((member) => `${member.upstream}.${member.type.name}`).join(', ');
  const isExact = candidate.exactCount === members.length;
  const reasons: ProposalReason[] = [
    {
      about: candidate.name,
      reason: isExact
        ? `${typeList} have the same name, so they are drafted as one concept.`
        : `${typeList} match as ${candidate.name} once a prefix or suffix is removed, so they are drafted as one concept.`,
      confidence: isExact ? Confidence.High : Confidence.Medium,
    },
    ...notReady.map((type) => ({
      about: `member ${type.upstream}`,
      reason: `${type.type} is left out. ${type.reason}`,
      confidence: Confidence.High,
    })),
  ];
  for (const member of members) {
    const clashes = generatedNameClashes(member, candidate.name);
    if (clashes.length > 0) {
      reasons.push({
        about: `member ${member.upstream}`,
        reason: `${member.upstream} has its own ${clashes.join(', ')}, which the unified API's generated ${candidate.name} mutations would clash with, so it won't compose. Rename the concept, or rename those mutations with a wiring override.`,
        confidence: Confidence.High,
      });
    }
  }
  const { fields, reasons: fieldReasons } = draftFields(members);
  reasons.push(...fieldReasons);
  const draftMembers = members.map((member): DraftMember => {
    const documents: DraftMember['documents'] = { [ConceptOperation.Fetch]: fetchDocument(member, fields) };
    reasons.push({
      about: `${member.upstream} fetch`,
      reason: `${member.lookup.name}(${ID_FIELD}: ID!) returns ${member.type.name}, so it is the fetch.`,
      confidence: Confidence.High,
    });
    for (const [operation, verb] of WRITE_VERBS) {
      const drafted = writeDocument(member, candidate.name, fields, operation, verb);
      if (drafted.text !== null) {
        documents[operation] = drafted.text;
      }
      reasons.push(drafted.reason);
    }
    return { upstream: member.upstream, documents };
  });
  return { definition: { name: candidate.name, fields, members: draftMembers }, reasons };
}

/**
 * Drafts concepts from the object types several upstreams share.
 *
 * @param schemas - Each upstream's cached schema, by upstream name.
 * @param [settings] - The proposer's tunables.
 * @returns The drafts, and the candidates with too few ready members.
 */
export function proposeConcepts(
  schemas: ReadonlyMap<string, GraphQLSchema>,
  settings: ProposalSettings = PROPOSAL_DEFAULTS,
): ConceptProposals {
  const refs = [...schemas].flatMap(([upstream, schema]) =>
    objectTypesOf(schema).map((type) => ({ upstream, schema, type })),
  );
  const proposals: ConceptProposals = { drafts: [], notReady: [] };
  for (const candidate of findCandidates(refs, settings)) {
    const ready: ReadyMember[] = [];
    const notReady: NotReadyType[] = [];
    for (const ref of candidate.matches) {
      const readiness = readinessOf(ref);
      if ('ready' in readiness) {
        ready.push(readiness.ready);
      } else {
        notReady.push({ upstream: ref.upstream, type: ref.type.name, reason: readiness.lacks });
      }
    }
    if (ready.length >= 2) {
      proposals.drafts.push(draftConcept(candidate, ready, notReady));
    } else {
      const types = [
        ...notReady,
        ...ready.map((member) => ({
          upstream: member.upstream,
          type: member.type.name,
          reason: 'Ready, but no other member is.',
        })),
      ];
      proposals.notReady.push({ name: candidate.name, types });
    }
  }
  return proposals;
}
