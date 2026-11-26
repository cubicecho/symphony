// Checks a concept's member documents against each member's schema, and that their variables can be bound.
//
// Variable binding, the rule the engine and the generator share:
// - `$key` binds the concept's key value, and so does a variable named after the key field (`$slug`).
// - A variable named after a shared field (`$name`) binds that field's value.
// - A variable named after an owned field binds it from the owner's own input, and only in the owner's documents.
// - Any other variable binds nothing: it is left out of the request, so it must be nullable or have a default.
// The documents adapt each upstream's input shape to the concept (`openAccount(input: { handle: $key })`),
// and aliases in the fetch selection adapt its output (`{ name: displayName }`).
import {
  type DocumentNode,
  type FieldNode,
  GraphQLError,
  type GraphQLSchema,
  getLocation,
  getNamedType,
  Kind,
  type Location,
  type OperationDefinitionNode,
  OperationTypeNode,
  parse,
  print,
  specifiedScalarTypes,
  type TypeNode,
  typeFromAST,
  type VariableDefinitionNode,
  validate,
} from 'graphql';
import { errorMessage } from '../core/errors.ts';
import {
  CONCEPT_OPERATIONS,
  type Concept,
  type ConceptField,
  type ConceptMember,
  ConceptOperation,
  FieldMode,
  KEY_VARIABLE,
  keyFieldOf,
} from './concept.ts';

/** One problem with a concept, placed in the member document it is about when it has a place. */
export interface ConceptProblem {
  concept: string;
  /** The member's upstream name, or null for a problem with the concept as a whole. */
  member: string | null;
  operation: ConceptOperation | null;
  message: string;
  /** 1-based, within the document's text, as CompileError counts. Null when the problem has no place. */
  line: number | null;
  column: number | null;
}

/** A member document that parsed and has the one operation and one root field every document must have. */
export interface MemberDocument {
  document: DocumentNode;
  operation: OperationDefinitionNode;
  /** The entity, or the write's payload: its response key is the first key of `data`. */
  rootField: FieldNode;
}

/** The operation type each stored document must have. */
const EXPECTED_OPERATION: Readonly<Record<ConceptOperation, OperationTypeNode>> = Object.freeze({
  [ConceptOperation.Fetch]: OperationTypeNode.QUERY,
  [ConceptOperation.Create]: OperationTypeNode.MUTATION,
  [ConceptOperation.Update]: OperationTypeNode.MUTATION,
  [ConceptOperation.Delete]: OperationTypeNode.MUTATION,
});

/** The operations that write every shared field, since shared fields go to every member. */
const WRITES_SHARED = new Set<ConceptOperation>([ConceptOperation.Create, ConceptOperation.Update]);

/** Names of the scalars every GraphQL schema has. Key and shared fields use only these, so members agree. */
const BUILT_IN_SCALARS = new Set(specifiedScalarTypes.map((scalar) => scalar.name));

/** A problem before the concept and member are filled in. */
type DocumentProblem = Pick<ConceptProblem, 'message' | 'line' | 'column'>;

/** Where one document problem came from. */
interface ProblemSite {
  member: string;
  operation: ConceptOperation;
}

/**
 * Applies the binding rule to one variable name.
 *
 * @param concept - The concept.
 * @param variable - A document variable's name, without the `$`.
 * @returns The concept field it binds, or undefined when it binds nothing.
 */
export function boundField(concept: Concept, variable: string): ConceptField | undefined {
  if (variable === KEY_VARIABLE) {
    return keyFieldOf(concept);
  }
  return concept.fields.find((field) => field.name === variable);
}

/**
 * Tells whether a variable must be sent: non-null and without a default.
 *
 * @param definition - The variable's definition.
 * @returns True when leaving it out makes the upstream refuse the request.
 */
export function isRequiredVariable(definition: VariableDefinitionNode): boolean {
  return definition.type.kind === Kind.NON_NULL_TYPE && definition.defaultValue === undefined;
}

/**
 * Places a parsed node in its document's text.
 *
 * @param location - The node's `loc`.
 * @returns Its 1-based line and column, or nulls when it has no location.
 */
function placeOf(location: Location | undefined): Pick<ConceptProblem, 'line' | 'column'> {
  if (location === undefined) {
    return { line: null, column: null };
  }
  const { line, column } = getLocation(location.source, location.start);
  return { line, column };
}

/**
 * Turns a graphql-js error into a problem at its first location.
 *
 * @param error - A syntax or validation error.
 * @returns The problem.
 */
function fromGraphqlError(error: GraphQLError): DocumentProblem {
  const [location] = error.locations ?? [];
  return { message: error.message, line: location?.line ?? null, column: location?.column ?? null };
}

/**
 * Parses one member document and checks its shape: one operation of the right type, with one root field.
 *
 * @param text - The document.
 * @param operation - Which of the member's documents it is.
 * @returns The parsed document, or the problems that stop it being used.
 */
export function readMemberDocument(
  text: string,
  operation: ConceptOperation,
): { parsed: MemberDocument | null; problems: DocumentProblem[] } {
  let document: DocumentNode;
  try {
    document = parse(text);
  } catch (error) {
    const problem = error instanceof GraphQLError ? fromGraphqlError(error) : null;
    return { parsed: null, problems: [problem ?? { message: errorMessage(error), line: null, column: null }] };
  }
  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  const [only] = operations;
  if (operations.length !== 1 || only === undefined) {
    const message = `A ${operation} document holds exactly one operation; this one has ${operations.length}.`;
    return { parsed: null, problems: [{ message, line: 1, column: 1 }] };
  }
  const expected = EXPECTED_OPERATION[operation];
  if (only.operation !== expected) {
    const message = `A ${operation} document is a ${expected}, not a ${only.operation}.`;
    return { parsed: null, problems: [{ message, ...placeOf(only.loc) }] };
  }
  const [rootField] = only.selectionSet.selections;
  if (only.selectionSet.selections.length !== 1 || rootField?.kind !== Kind.FIELD) {
    const message = `A ${operation} document selects exactly one root field, with no fragment around it.`;
    return { parsed: null, problems: [{ message, ...placeOf(only.selectionSet.loc) }] };
  }
  return { parsed: { document, operation: only, rootField }, problems: [] };
}

/**
 * Checks the variables of one document against the binding rule.
 *
 * @param concept - The concept.
 * @param member - The member the document belongs to.
 * @param operation - Which document it is.
 * @param parsed - The document.
 * @returns The binding problems.
 */
function bindingProblems(
  concept: Concept,
  member: ConceptMember,
  operation: ConceptOperation,
  parsed: MemberDocument,
): DocumentProblem[] {
  const problems: DocumentProblem[] = [];
  const definitions = parsed.operation.variableDefinitions ?? [];
  const bound = new Set<string>();
  for (const definition of definitions) {
    const name = definition.variable.name.value;
    const field = boundField(concept, name);
    const place = placeOf(definition.loc);
    if (field === undefined) {
      if (isRequiredVariable(definition)) {
        const message = `$${name} is required but binds nothing: no concept field is called "${name}". Rename it after a field, or make it nullable.`;
        problems.push({ message, ...place });
      }
    } else if (field.mode === FieldMode.Owned && field.owner !== member.upstream) {
      problems.push({
        message: `$${name} binds "${name}", which ${field.owner} owns, not ${member.upstream}.`,
        ...place,
      });
    } else {
      bound.add(field.name);
    }
  }
  const operationPlace = placeOf(parsed.operation.loc);
  const key = keyFieldOf(concept);
  if (bound.has(key.name) === false) {
    problems.push({
      message: `A ${operation} document binds the key, as $${KEY_VARIABLE} or $${key.name}.`,
      ...operationPlace,
    });
  }
  if (WRITES_SHARED.has(operation)) {
    const unbound = concept.fields.filter(
      (field) => field.mode === FieldMode.Shared && bound.has(field.name) === false,
    );
    for (const field of unbound) {
      const message = `A ${operation} document binds every shared field, since each member stores it; $${field.name} is missing.`;
      problems.push({ message, ...operationPlace });
    }
  }
  return problems;
}

/**
 * Checks that a fetch selects the key and every shared field, by response key, so reads can compare them.
 *
 * @param concept - The concept.
 * @param parsed - The fetch document.
 * @returns The problems.
 */
function fetchSelectionProblems(concept: Concept, parsed: MemberDocument): DocumentProblem[] {
  const selections = parsed.rootField.selectionSet?.selections ?? [];
  const responseKeys = new Set(
    selections.flatMap((selection) =>
      selection.kind === Kind.FIELD ? [selection.alias?.value ?? selection.name.value] : [],
    ),
  );
  const compared = concept.fields.filter((field) => field.mode !== FieldMode.Owned);
  const missing = compared.filter((field) => responseKeys.has(field.name) === false);
  const place = placeOf(parsed.rootField.loc);
  return missing.map((field) => ({
    message: `The fetch selects "${field.name}" directly under ${parsed.rootField.name.value}; alias the upstream's field to that name if it differs.`,
    ...place,
  }));
}

/** A variable that binds the key or a shared field, kept to compare its type across members. */
interface SharedBinding extends ProblemSite {
  field: string;
  definition: VariableDefinitionNode;
  /** Its type without the outer `!`, as SDL prints it. */
  typeText: string;
}

/**
 * Strips the outer non-null from a type.
 *
 * @param type - A variable's type.
 * @returns The same type, nullable.
 */
export function nullableType(type: TypeNode): TypeNode {
  return type.kind === Kind.NON_NULL_TYPE ? type.type : type;
}

/**
 * Checks that the key and each shared field have one type everywhere, and that it is a built-in scalar.
 *
 * @param concept - The concept.
 * @param bindings - Every variable binding the key or a shared field, in member then operation order.
 * @param schemas - Each member's schema.
 * @returns The problems, as full ConceptProblems.
 */
function sharedTypeProblems(
  concept: Concept,
  bindings: SharedBinding[],
  schemas: ReadonlyMap<string, GraphQLSchema>,
): ConceptProblem[] {
  const problems: ConceptProblem[] = [];
  const firstByField = new Map<string, SharedBinding>();
  for (const binding of bindings) {
    const site = { concept: concept.name, member: binding.member, operation: binding.operation };
    const place = placeOf(binding.definition.loc);
    const schema = schemas.get(binding.member);
    const resolved = schema === undefined ? undefined : typeFromAST(schema, binding.definition.type);
    const namedType = resolved === undefined ? undefined : getNamedType(resolved);
    const isBuiltIn = namedType !== undefined && BUILT_IN_SCALARS.has(namedType.name);
    if (isBuiltIn === false) {
      const message = `"${binding.field}" is the key or shared, so its type must be a built-in scalar in every member; ${binding.typeText} is not.`;
      problems.push({ ...site, message, ...place });
      continue;
    }
    const first = firstByField.get(binding.field);
    if (first === undefined) {
      firstByField.set(binding.field, binding);
    } else if (first.typeText !== binding.typeText) {
      const message = `"${binding.field}" is ${binding.typeText} here but ${first.typeText} in ${first.member}'s ${first.operation}.`;
      problems.push({ ...site, message, ...place });
    }
  }
  return problems;
}

/**
 * Collects the variables of one document that bind the key or a shared field.
 *
 * @param concept - The concept.
 * @param site - The member and operation.
 * @param parsed - The document.
 * @returns The bindings.
 */
function sharedBindingsOf(concept: Concept, site: ProblemSite, parsed: MemberDocument): SharedBinding[] {
  return (parsed.operation.variableDefinitions ?? []).flatMap((definition) => {
    const field = boundField(concept, definition.variable.name.value);
    if (field === undefined || field.mode === FieldMode.Owned) {
      return [];
    }
    return [{ ...site, field: field.name, definition, typeText: print(nullableType(definition.type)) }];
  });
}

/**
 * Validates every member document of one concept.
 *
 * @param concept - A concept that parsed with conceptSchema.
 * @param schemas - Each upstream's schema, by upstream name.
 * @returns The problems, empty when the concept can be served.
 */
export function validateConcept(concept: Concept, schemas: ReadonlyMap<string, GraphQLSchema>): ConceptProblem[] {
  const problems: ConceptProblem[] = [];
  const sharedBindings: SharedBinding[] = [];
  for (const member of concept.members) {
    const schema = schemas.get(member.upstream);
    if (schema === undefined) {
      const message = `There is no schema for the upstream "${member.upstream}". Add it, or refresh its schema.`;
      problems.push({
        concept: concept.name,
        member: member.upstream,
        operation: null,
        message,
        line: null,
        column: null,
      });
      continue;
    }
    for (const operation of CONCEPT_OPERATIONS) {
      const site = { concept: concept.name, member: member.upstream, operation };
      const { parsed, problems: shapeProblems } = readMemberDocument(member.documents[operation], operation);
      problems.push(...shapeProblems.map((problem) => ({ ...site, ...problem })));
      if (parsed === null) {
        continue;
      }
      const schemaErrors = validate(schema, parsed.document).map(fromGraphqlError);
      const selectionErrors = operation === ConceptOperation.Fetch ? fetchSelectionProblems(concept, parsed) : [];
      const bindingErrors = bindingProblems(concept, member, operation, parsed);
      problems.push(
        ...[...schemaErrors, ...selectionErrors, ...bindingErrors].map((problem) => ({ ...site, ...problem })),
      );
      sharedBindings.push(...sharedBindingsOf(concept, site, parsed));
    }
  }
  problems.push(...sharedTypeProblems(concept, sharedBindings, schemas));
  return problems;
}

/** A member's four documents, parsed. */
export type MemberDocuments = Readonly<Record<ConceptOperation, MemberDocument>>;

/**
 * Parses one document of a validated member.
 *
 * @param member - The member.
 * @param operation - Which document.
 * @returns The parsed document.
 * @throws When it does not read, which means the concept skipped validation.
 */
function readValidated(member: ConceptMember, operation: ConceptOperation): MemberDocument {
  const { parsed, problems } = readMemberDocument(member.documents[operation], operation);
  if (parsed === null) {
    const reason = problems.map((problem) => problem.message).join(' ');
    throw new Error(`${member.upstream}'s ${operation} document does not read: ${reason} Run validateConcepts first.`);
  }
  return parsed;
}

/**
 * Parses a validated member's four documents, for the generator and the engine.
 *
 * @param member - A member of a concept that passed validateConcept.
 * @returns Each document, parsed.
 * @throws When a document does not read, which means the concept skipped validation.
 */
export function memberDocuments(member: ConceptMember): MemberDocuments {
  return Object.freeze({
    fetch: readValidated(member, ConceptOperation.Fetch),
    create: readValidated(member, ConceptOperation.Create),
    update: readValidated(member, ConceptOperation.Update),
    delete: readValidated(member, ConceptOperation.Delete),
  });
}

/**
 * Validates a set of concepts that will be served together.
 *
 * @param concepts - Concepts that parsed with conceptSchema.
 * @param schemas - Each upstream's schema, by upstream name.
 * @returns Every problem, empty when the set can be served as one schema.
 */
export function validateConcepts(
  concepts: readonly Concept[],
  schemas: ReadonlyMap<string, GraphQLSchema>,
): ConceptProblem[] {
  const names = concepts.map((concept) => concept.name);
  const repeated = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  const clashes = repeated.map((name) => ({
    concept: name,
    member: null,
    operation: null,
    message: `Two concepts are called ${name}; their generated types would clash.`,
    line: null,
    column: null,
  }));
  return [...clashes, ...concepts.flatMap((concept) => validateConcept(concept, schemas))];
}
