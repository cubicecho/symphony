// A concept: one domain entity (a Team, say) that lives in several upstreams and is read and written as one.
// It is data: which fields every member shares, which one member owns, and per member the GraphQL documents
// that fetch, create, update and delete it in that upstream's own schema. Every entity is identified by one
// Symphony UUID, its `id`, which every member stores as its own id; no concept declares it as a field.
import { z } from 'zod';

/** How a concept field is written and read. */
export const FieldMode = {
  /** Written to every member, and compared across them for drift on read. */
  Shared: 'shared',
  /** Lives in exactly one member, its owner. */
  Owned: 'owned',
} as const;
export type FieldMode = (typeof FieldMode)[keyof typeof FieldMode];

/** The four documents a member stores, and the operation type each must be. */
export const ConceptOperation = {
  Fetch: 'fetch',
  Create: 'create',
  Update: 'update',
  Delete: 'delete',
} as const;
export type ConceptOperation = (typeof ConceptOperation)[keyof typeof ConceptOperation];

/** Every operation, in the order problems are reported. */
export const CONCEPT_OPERATIONS: readonly ConceptOperation[] = Object.values(ConceptOperation);

/** The field of the generated concept type, and the argument, that hold the entity's Symphony UUID. */
export const ID_FIELD = 'id';

/** The variable every member document binds the entity's id to, as `$id`. */
export const ID_VARIABLE = 'id';

/** The field of the generated concept type that lists each member's presence. */
export const PRESENCE_FIELD = 'presence';

/** Argument names the generated mutations take for themselves, so no member's argument may use them. */
const RESERVED_ARGUMENTS = new Set([ID_FIELD, 'shared', 'in', 'except', 'app', 'own']);

/** Concept names whose generated query or types would clash with the subgraph's own (generate.ts) or a scalar. */
const RESERVED_CONCEPT_NAMES = new Set([
  'Concepts',
  'Query',
  'Mutation',
  'JSON',
  'PresenceStatus',
  'FieldDrift',
  'AppWriteResult',
  'ID',
  'String',
  'Int',
  'Float',
  'Boolean',
]);

/** Field names the generated concept type uses itself, with why, so no concept field may take them. */
const RESERVED_FIELD_NAMES: ReadonlyMap<string, string> = new Map([
  [ID_FIELD, "every concept has it already, as the entity's Symphony UUID"],
  [PRESENCE_FIELD, 'the generated concept type uses it'],
]);

/** A GraphQL type name: the concept's name prefixes every generated type. */
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;

/** A GraphQL field and variable name. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What splits an upstream name into words: Symphony allows spaces, dots, dashes and underscores. */
const WORD_SEPARATOR = /[\s._-]+/;

const sharedField = z.object({ name: z.string().regex(FIELD_NAME), mode: z.literal(FieldMode.Shared) });
const ownedField = z.object({
  name: z.string().regex(FIELD_NAME),
  mode: z.literal(FieldMode.Owned),
  /** The member upstream's name. */
  owner: z.string().min(1),
});

/** One field of a concept. Its GraphQL type comes from the variables that bind it (validate.ts). */
export const conceptFieldSchema = z.discriminatedUnion('mode', [sharedField, ownedField]);
export type ConceptField = z.infer<typeof conceptFieldSchema>;

/** One upstream's part in a concept: its documents, each written against that upstream's schema. */
export const conceptMemberSchema = z.object({
  /** The upstream's name. */
  upstream: z.string().min(1),
  /** Whether a create that names no apps (`in`) writes to this member. Left out, it does. */
  createByDefault: z.boolean().optional(),
  documents: z.object({
    /** A query with one root field: the entity, or null when this upstream has none with the id. */
    fetch: z.string().min(1),
    create: z.string().min(1),
    update: z.string().min(1),
    delete: z.string().min(1),
  }),
});
export type ConceptMember = z.infer<typeof conceptMemberSchema>;

/** A concept definition, as stored. */
export const conceptSchema = z
  .object({
    name: z
      .string()
      .regex(TYPE_NAME, 'A concept name is a GraphQL type name in PascalCase, such as Team.')
      .refine((name) => RESERVED_CONCEPT_NAMES.has(name) === false, 'That name is taken by the subgraph itself.'),
    fields: z.array(conceptFieldSchema).min(1),
    members: z.array(conceptMemberSchema).min(1),
  })
  .superRefine((concept, context) => {
    for (const message of conceptRuleBreaks(concept)) {
      context.addIssue({ code: 'custom', message });
    }
  });
export type Concept = z.infer<typeof conceptSchema>;

/**
 * Lists the rules a concept's fields and members break, beyond their shapes.
 *
 * @param concept - A concept whose shape already parsed.
 * @returns One message per broken rule.
 */
function conceptRuleBreaks(concept: Pick<Concept, 'fields' | 'members'>): string[] {
  const breaks: string[] = [];
  const memberNames = concept.members.map((member) => member.upstream);
  for (const name of duplicates(memberNames)) {
    breaks.push(`The upstream "${name}" is listed as a member more than once.`);
  }
  for (const name of duplicates(concept.fields.map((field) => field.name))) {
    breaks.push(`The field "${name}" is defined more than once.`);
  }
  for (const field of concept.fields) {
    const reservedBecause = RESERVED_FIELD_NAMES.get(field.name);
    if (reservedBecause !== undefined) {
      breaks.push(`No field may be called "${field.name}": ${reservedBecause}.`);
    }
    const hasOwner = field.mode === FieldMode.Owned && memberNames.includes(field.owner);
    if (field.mode === FieldMode.Owned && hasOwner === false) {
      breaks.push(`The field "${field.name}" is owned by "${field.owner}", which is not a member.`);
    }
  }
  breaks.push(...memberNameBreaks(memberNames));
  return breaks;
}

/**
 * Checks that every member's upstream name makes a usable argument and enum value.
 *
 * @param memberNames - The members' upstream names.
 * @returns One message per unusable or clashing name.
 */
function memberNameBreaks(memberNames: string[]): string[] {
  const breaks: string[] = [];
  for (const name of memberNames) {
    const argument = memberArgumentName(name);
    const isUsable = FIELD_NAME.test(argument);
    if (isUsable === false) {
      breaks.push(`The upstream name "${name}" must start with a letter to name a GraphQL argument.`);
    } else if (RESERVED_ARGUMENTS.has(argument)) {
      breaks.push(`The upstream name "${name}" becomes the argument "${argument}", which the mutations use already.`);
    }
  }
  for (const argument of duplicates(memberNames.map(memberArgumentName))) {
    breaks.push(`Two members' upstream names both become the argument "${argument}".`);
  }
  return breaks;
}

/**
 * Finds the values that occur more than once.
 *
 * @param values - Any strings.
 * @returns Each repeated value once.
 */
function duplicates(values: string[]): string[] {
  const repeated = values.filter((value, index) => values.indexOf(value) !== index);
  return [...new Set(repeated)];
}

/**
 * Tells whether a create that names no apps writes to a member.
 *
 * @param member - The member.
 * @returns Its `createByDefault`, true when left out.
 */
export function createsByDefault(member: Pick<ConceptMember, 'createByDefault'>): boolean {
  return member.createByDefault ?? true;
}

/**
 * Lists the fields one member writes besides the id: every shared field, and the fields it owns.
 *
 * @param concept - The concept.
 * @param upstream - The member's upstream name.
 * @returns Those fields, in definition order.
 */
export function fieldsWrittenBy(concept: Concept, upstream: string): ConceptField[] {
  return concept.fields.filter(
    (field) => field.mode === FieldMode.Shared || (field.mode === FieldMode.Owned && field.owner === upstream),
  );
}

/**
 * Lists the fields one member owns.
 *
 * @param concept - The concept.
 * @param upstream - The member's upstream name.
 * @returns Those fields, in definition order.
 */
export function fieldsOwnedBy(concept: Concept, upstream: string): ConceptField[] {
  return concept.fields.filter((field) => field.mode === FieldMode.Owned && field.owner === upstream);
}

/**
 * Splits an upstream name into its words.
 *
 * @param upstream - The upstream's name, such as `billing.v2`.
 * @returns The non-empty words, such as `['billing', 'v2']`.
 */
function wordsOf(upstream: string): string[] {
  return upstream.split(WORD_SEPARATOR).filter((word) => word.length > 0);
}

/**
 * Capitalizes a word's first letter.
 *
 * @param word - Any word.
 * @returns The word with its first letter upper-cased.
 */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Names the argument a member's own fields travel in: `billing.v2` becomes `billingV2`.
 *
 * @param upstream - The member's upstream name.
 * @returns A camelCase name.
 */
export function memberArgumentName(upstream: string): string {
  const [first = '', ...rest] = wordsOf(upstream);
  return first.charAt(0).toLowerCase() + first.slice(1) + rest.map(capitalize).join('');
}

/**
 * Names a member inside generated type names: `billing.v2` becomes `BillingV2`.
 *
 * @param upstream - The member's upstream name.
 * @returns A PascalCase name.
 */
export function memberTypeName(upstream: string): string {
  return capitalize(memberArgumentName(upstream));
}

/**
 * Names a member's value in the concept's `<Name>App` enum: `billing.v2` becomes `BILLING_V2`.
 *
 * @param upstream - The member's upstream name.
 * @returns A SCREAMING_CASE name.
 */
export function memberEnumValue(upstream: string): string {
  return wordsOf(upstream)
    .map((word) => word.toUpperCase())
    .join('_');
}

/**
 * Lowers a type name's first letter, for the concept's query field: `Team` becomes `team`.
 *
 * @param name - A PascalCase name.
 * @returns The camelCase name.
 */
export function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
