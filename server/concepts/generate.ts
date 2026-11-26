// Generates the SDL of the concept subgraph: per concept, the inputs its mutations take, its presence and
// write-result types, one query and four mutations. Types come from the variables that bind each field
// (validate.ts); an upstream input, enum or scalar an owned field uses is copied under a member prefix.
import {
  type ASTNode,
  type GraphQLSchema,
  Kind,
  type NamedTypeNode,
  parse,
  print,
  printType,
  specifiedScalarTypes,
  type TypeNode,
  type VariableDefinitionNode,
  visit,
} from 'graphql';
import {
  type Concept,
  type ConceptField,
  ConceptOperation,
  FieldMode,
  fieldsOwnedBy,
  keyFieldOf,
  lowerFirst,
  memberArgumentName,
  memberEnumValue,
  memberTypeName,
  PRESENCE_FIELD,
} from './concept.ts';
import { boundField, isRequiredVariable, type MemberDocuments, memberDocuments, nullableType } from './validate.ts';

/** The types every concept shares, written once however many concepts there are. */
const COMMON_SDL = /* GraphQL */ `
"Any JSON value."
scalar JSON

"How one member upstream holds an entity."
enum PresenceStatus {
  "It has the entity, and its shared fields match the first member that has it."
  PRESENT
  "Its fetch found nothing for the key."
  MISSING
  "It has the entity, but a shared field differs."
  DRIFTED
  "Its fetch failed."
  ERROR
}

"A shared field whose value differs between members."
type FieldDrift {
  field: String!
  "The value in the first member that has the entity."
  expected: JSON
  "The value in this member."
  actual: JSON
}

"What one member upstream did with a write."
type AppWriteResult {
  "The upstream's name."
  app: String!
  ok: Boolean!
  "Why it failed, when it did."
  error: String
}
`;

/** A Query field every subgraph has, so a subgraph with no concepts is still a valid schema. */
export const SERVED_CONCEPTS_FIELD = 'concepts';

/** Names of the scalars every schema has, which need no copy. */
const BUILT_IN_SCALARS = new Set(specifiedScalarTypes.map((scalar) => scalar.name));

/** The names generated for one concept. */
export interface ConceptNames {
  /** The concept's object type: `Team`. */
  type: string;
  /** Its query field: `team`. */
  query: string;
  app: string;
  presence: string;
  writeResult: string;
  shared: string;
  sharedPatch: string;
  create: string;
  update: string;
  attach: string;
  delete: string;
  /** `TeamBillingOwn`: the create input of one member's owned fields. */
  own: (upstream: string) => string;
  ownPatch: (upstream: string) => string;
}

/**
 * Names everything generated for a concept, so the generator and the resolvers agree.
 *
 * @param concept - The concept.
 * @returns Its type, input and field names.
 */
export function conceptNames(concept: Concept): ConceptNames {
  const { name } = concept;
  return {
    type: name,
    query: lowerFirst(name),
    app: `${name}App`,
    presence: `${name}Presence`,
    writeResult: `${name}WriteResult`,
    shared: `${name}Shared`,
    sharedPatch: `${name}SharedPatch`,
    create: `create${name}`,
    update: `update${name}`,
    attach: `attach${name}`,
    delete: `delete${name}`,
    own: (upstream) => `${name}${memberTypeName(upstream)}Own`,
    ownPatch: (upstream) => `${name}${memberTypeName(upstream)}OwnPatch`,
  };
}

/** The upstream types copied for one member, by their new name. */
type CopiedTypes = Map<string, string>;

/**
 * Renames every non-built-in type an AST names, and copies each from the member's schema.
 *
 * @param node - A type reference or a type definition.
 * @param prefix - The member prefix, `TeamBilling`.
 * @param schema - The member's schema.
 * @param copies - Copies made so far; this adds to it.
 * @returns The node with its named types renamed.
 */
function renameTypes<T extends ASTNode>(node: T, prefix: string, schema: GraphQLSchema, copies: CopiedTypes): T {
  const referenced: string[] = [];
  const renamed = visit(node, {
    NamedType(named: NamedTypeNode): NamedTypeNode | undefined {
      if (BUILT_IN_SCALARS.has(named.name.value)) {
        return undefined;
      }
      referenced.push(named.name.value);
      return { ...named, name: { kind: Kind.NAME, value: `${prefix}_${named.name.value}` } };
    },
  });
  for (const name of referenced) {
    copyType(name, prefix, schema, copies);
  }
  return renamed;
}

/**
 * Copies an upstream input, enum or scalar type under a member prefix, with the types it uses.
 *
 * @param name - The type's name in the upstream.
 * @param prefix - The member prefix.
 * @param schema - The member's schema.
 * @param copies - Copies made so far; this adds to it.
 * @throws When the schema has no such type, which validation would have caught.
 */
function copyType(name: string, prefix: string, schema: GraphQLSchema, copies: CopiedTypes): void {
  const copyName = `${prefix}_${name}`;
  if (copies.has(copyName)) {
    return;
  }
  const type = schema.getType(name);
  if (type === undefined || type === null) {
    throw new Error(`The upstream schema has no type ${name}. Run validateConcepts first.`);
  }
  // Claimed before recursing, so input types that refer to each other copy once.
  copies.set(copyName, '');
  const [definition] = parse(printType(type)).definitions;
  if (definition === undefined || 'name' in definition === false || definition.name === undefined) {
    throw new Error(`Could not copy the upstream type ${name}.`);
  }
  const renamed = renameTypes(definition, prefix, schema, copies);
  copies.set(copyName, print({ ...renamed, name: { kind: Kind.NAME, value: copyName } }));
}

/**
 * Finds the variable that binds one field in a document.
 *
 * @param concept - The concept.
 * @param documents - A member's documents.
 * @param operation - Which document.
 * @param field - The field.
 * @returns Its definition, or undefined when the document does not bind it.
 */
function bindingOf(
  concept: Concept,
  documents: MemberDocuments,
  operation: ConceptOperation,
  field: ConceptField,
): VariableDefinitionNode | undefined {
  const definitions = documents[operation].operation.variableDefinitions ?? [];
  return definitions.find((definition) => boundField(concept, definition.variable.name.value) === field);
}

/**
 * Prints an input field line from a variable's type.
 *
 * @param name - The field's name.
 * @param type - The (renamed) variable type.
 * @param isRequired - Whether the input field keeps the type's outer `!`.
 * @returns `name: Type`.
 */
function inputLine(name: string, type: TypeNode, isRequired: boolean): string {
  const typeText = isRequired ? print(type) : print(nullableType(type));
  return `  ${name}: ${typeText}`;
}

/** What the generator knows about one member of a concept. */
interface MemberPlan {
  upstream: string;
  documents: MemberDocuments;
  schema: GraphQLSchema;
}

/** A concept's generated pieces, before they are joined with the others. */
interface ConceptSdl {
  types: string[];
  queries: string[];
  mutations: string[];
}

/**
 * Builds one member's `Own` and `OwnPatch` inputs, copying the upstream types they use.
 *
 * @param concept - The concept.
 * @param member - The member.
 * @returns The input definitions, and the argument lines that take them on create and update.
 */
function ownInputs(concept: Concept, member: MemberPlan): { types: string[]; createArg: string; updateArg: string } {
  const names = conceptNames(concept);
  const prefix = `${concept.name}${memberTypeName(member.upstream)}`;
  const copies: CopiedTypes = new Map();
  const owned = fieldsOwnedBy(concept, member.upstream);
  const lines = (operation: ConceptOperation, isPatch: boolean) =>
    owned.flatMap((field) => {
      const definition = bindingOf(concept, member.documents, operation, field);
      if (definition === undefined) {
        return [];
      }
      const type = renameTypes(definition.type, prefix, member.schema, copies);
      return [inputLine(field.name, type, isPatch === false && isRequiredVariable(definition))];
    });
  const createLines = lines(ConceptOperation.Create, false);
  const updateLines = lines(ConceptOperation.Update, true);
  const argument = memberArgumentName(member.upstream);
  const types: string[] = [];
  let createArg = '';
  let updateArg = '';
  if (createLines.length > 0) {
    types.push(
      `"${member.upstream}'s own fields, on create."\ninput ${names.own(member.upstream)} {\n${createLines.join('\n')}\n}`,
    );
    createArg = `${argument}: ${names.own(member.upstream)}`;
  }
  if (updateLines.length > 0) {
    types.push(
      `"${member.upstream}'s own fields, on update. Leave one out to keep it."\ninput ${names.ownPatch(member.upstream)} {\n${updateLines.join('\n')}\n}`,
    );
    updateArg = `${argument}: ${names.ownPatch(member.upstream)}`;
  }
  return { types: [...types, ...copies.values()], createArg, updateArg };
}

/**
 * Generates one concept's types, query and mutations.
 *
 * @param concept - A validated concept.
 * @param schemas - Each upstream's schema.
 * @returns Its SDL pieces.
 */
function generateConcept(concept: Concept, schemas: ReadonlyMap<string, GraphQLSchema>): ConceptSdl {
  const names = conceptNames(concept);
  const members: MemberPlan[] = concept.members.map((member) => {
    const schema = schemas.get(member.upstream);
    if (schema === undefined) {
      throw new Error(`There is no schema for ${member.upstream}. Run validateConcepts first.`);
    }
    return { upstream: member.upstream, documents: memberDocuments(member), schema };
  });
  const key = keyFieldOf(concept);
  const shared = concept.fields.filter((field) => field.mode === FieldMode.Shared);
  // Key and shared types are built-in scalars and agree across members (validate.ts), so any create says them.
  const createBindings = (field: ConceptField) =>
    members.flatMap((member) => bindingOf(concept, member.documents, ConceptOperation.Create, field) ?? []);
  const typeOf = (field: ConceptField) => {
    const [first] = createBindings(field);
    if (first === undefined) {
      throw new Error(`No create document binds ${concept.name}.${field.name}. Run validateConcepts first.`);
    }
    return print(nullableType(first.type));
  };
  const keyType = typeOf(key);
  const sharedLines = shared.map((field) => {
    const isRequired = createBindings(field).some(isRequiredVariable);
    return `  ${field.name}: ${typeOf(field)}${isRequired ? '!' : ''}`;
  });
  const patchLines = shared.map((field) => `  ${field.name}: ${typeOf(field)}`);
  const own = members.map((member) => ownInputs(concept, member));
  const appValues = concept.members.map((member) => `  ${memberEnumValue(member.upstream)}`);

  const types = [
    `"The upstreams a ${concept.name} can live in."\nenum ${names.app} {\n${appValues.join('\n')}\n}`,
    `"How one upstream holds a ${concept.name}."\ntype ${names.presence} {\n  app: ${names.app}!\n  status: PresenceStatus!\n  drift: [FieldDrift!]!\n  "Why the fetch failed, when it did."\n  error: String\n  "What the upstream's fetch returned."\n  data: JSON\n}`,
    `type ${names.type} {\n  ${key.name}: ${keyType}!\n${shared.map((field) => `  ${field.name}: ${typeOf(field)}`).join('\n')}\n  "Every member upstream, and how it holds this ${concept.name}."\n  ${PRESENCE_FIELD}: [${names.presence}!]!\n}`,
    `"What a write to a ${concept.name} did in each upstream. Nothing is rolled back."\ntype ${names.writeResult} {\n  key: ${keyType}!\n  results: [AppWriteResult!]!\n  "True when any upstream failed."\n  partial: Boolean!\n}`,
    `"The key and shared fields of a new ${concept.name}."\ninput ${names.shared} {\n  ${key.name}: ${keyType}!\n${sharedLines.join('\n')}\n}`,
    ...own.flatMap((member) => member.types),
  ];
  const hasSharedPatch = patchLines.length > 0;
  if (hasSharedPatch) {
    types.push(
      `"Shared fields to change on every upstream. Leave one out to keep it."\ninput ${names.sharedPatch} {\n${patchLines.join('\n')}\n}`,
    );
  }
  const createArgs = [`shared: ${names.shared}!`, ...own.map((member) => member.createArg), `in: [${names.app}!]!`];
  const updateArgs = [
    `key: ${keyType}!`,
    ...(hasSharedPatch ? [`shared: ${names.sharedPatch}`] : []),
    ...own.map((member) => member.updateArg),
  ];
  const argList = (args: string[]) => args.filter((arg) => arg.length > 0).join(', ');
  return {
    types,
    queries: [
      `  "A ${concept.name} by its key, read from every upstream. Null when none has it."\n  ${names.query}(key: ${keyType}!): ${names.type}`,
    ],
    mutations: [
      `  "Creates a ${concept.name} in the chosen upstreams at once."\n  ${names.create}(${argList(createArgs)}): ${names.writeResult}!`,
      `  "Changes shared fields in every upstream, and own fields in their owner."\n  ${names.update}(${argList(updateArgs)}): ${names.writeResult}!`,
      `  "Creates an existing ${concept.name} in one more upstream, copying its shared fields. \`own\` holds that upstream's own fields."\n  ${names.attach}(key: ${keyType}!, app: ${names.app}!, own: JSON): ${names.writeResult}!`,
      `  "Deletes a ${concept.name} from every upstream. One that has none already counts as done."\n  ${names.delete}(key: ${keyType}!): ${names.writeResult}!`,
    ],
  };
}

/**
 * Generates the SDL of the subgraph that serves a set of concepts.
 *
 * @param concepts - Concepts that passed validateConcepts with these schemas.
 * @param schemas - Each upstream's schema, by upstream name.
 * @returns The SDL, with one Query and one Mutation type holding every concept's fields.
 */
export function generateConceptSdl(concepts: readonly Concept[], schemas: ReadonlyMap<string, GraphQLSchema>): string {
  const generated = concepts.map((concept) => generateConcept(concept, schemas));
  const types = generated.flatMap((one) => one.types);
  const queries = generated.flatMap((one) => one.queries);
  const mutations = generated.flatMap((one) => one.mutations);
  const servedField = `  "The names of the concepts this subgraph serves."\n  ${SERVED_CONCEPTS_FIELD}: [String!]!`;
  const hasMutations = mutations.length > 0;
  return [
    COMMON_SDL.trim(),
    ...types,
    `type Query {\n${[servedField, ...queries].join('\n')}\n}`,
    ...(hasMutations ? [`type Mutation {\n${mutations.join('\n')}\n}`] : []),
  ].join('\n\n');
}
