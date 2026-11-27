// The concept subgraph: the generated SDL with the engine's resolvers behind it, as one executable schema.
import { GraphQLScalarType, type GraphQLSchema, valueFromASTUntyped } from 'graphql';
import { createSchema } from 'graphql-yoga';
import { badInput } from '../core/errors.ts';
import { type Concept, ID_FIELD, memberApp, memberArgumentName, memberEnumValue } from './concept.ts';
import { createConceptEngine, type ExecuteUpstream, type FieldValues, isRecord } from './engine.ts';
import { conceptNames, generateConceptSdl, SERVED_CONCEPTS_FIELD } from './generate.ts';
import { type ConceptProblem, validateConcepts } from './validate.ts';

/** Thrown when concepts cannot be served: their documents do not fit the members' schemas. */
export class ConceptValidationError extends Error {
  readonly problems: ConceptProblem[];

  /**
   * @param problems - What validateConcepts found.
   */
  constructor(problems: ConceptProblem[]) {
    const lines = problems.map((problem) => {
      const where = [problem.concept, problem.member, problem.operation].filter((part) => part !== null).join(' / ');
      const place = problem.line === null ? '' : ` (line ${problem.line}, column ${problem.column})`;
      return `- ${where}${place}: ${problem.message}`;
    });
    super(`The concepts cannot be served. Fix these and try again:\n${lines.join('\n')}`);
    this.name = 'ConceptValidationError';
    this.problems = problems;
  }
}

/** Any JSON value, passed through as it is. */
const JsonScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Any JSON value.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (node, variables) => valueFromASTUntyped(node, variables),
});

/** Field resolvers by field name, as graphql-yoga takes them. */
type FieldResolvers = Record<string, (parent: unknown, args: Record<string, unknown>) => unknown>;

/**
 * Reads an input argument as field values.
 *
 * @param value - The argument, which may be absent.
 * @returns Its fields, or none.
 */
function fieldValues(value: unknown): FieldValues {
  return isRecord(value) ? value : {};
}

/**
 * Reads the `id` argument, which the engine checks is a UUID before calling any upstream.
 *
 * @param args - The field's arguments.
 * @returns The id as sent, or undefined when it was left out.
 */
function idArgument(args: Record<string, unknown>): string | undefined {
  const id = args[ID_FIELD];
  return id === undefined || id === null ? undefined : String(id);
}

/**
 * Reads a list argument of apps, which the enum has already turned into member names.
 *
 * @param value - The argument, which may be absent or null.
 * @returns The names, or undefined when it was left out.
 */
function listArgument(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

/**
 * Reads an `id: ID!` argument, which GraphQL has already made sure is there.
 *
 * @param args - The field's arguments.
 * @returns The id as sent.
 */
function requiredIdArgument(args: Record<string, unknown>): string {
  return idArgument(args) ?? '';
}

/**
 * Builds one concept's resolvers over its engine.
 *
 * @param concept - A validated concept.
 * @param execute - Sends a request to an upstream by name.
 * @returns Its enum mapping, query and mutation resolvers.
 */
function conceptResolvers(
  concept: Concept,
  execute: ExecuteUpstream,
): { app: Record<string, string>; query: FieldResolvers; mutation: FieldResolvers } {
  const names = conceptNames(concept);
  const engine = createConceptEngine(concept, execute);
  const apps = concept.members.map(memberApp);
  // Each member's own fields arrive in an argument named after it; the engine keys them by member name.
  const ownByApp = (args: Record<string, unknown>) =>
    Object.fromEntries(apps.map((app) => [app, fieldValues(args[memberArgumentName(app)])]));
  return {
    // The enum's values resolve to member names, so the engine never sees `BILLING`.
    app: Object.fromEntries(apps.map((app) => [memberEnumValue(app), app])),
    query: { [names.query]: (_parent, args) => engine.read(requiredIdArgument(args)) },
    mutation: {
      [names.create]: (_parent, args) =>
        engine.create({
          id: idArgument(args),
          shared: fieldValues(args.shared),
          own: ownByApp(args),
          in: listArgument(args.in),
          except: listArgument(args.except),
        }),
      [names.update]: (_parent, args) =>
        engine.update({ id: requiredIdArgument(args), shared: fieldValues(args.shared), own: ownByApp(args) }),
      [names.attach]: (_parent, args) => {
        const own = args.own ?? {};
        if (isRecord(own) === false) {
          throw badInput('`own` is an object of the upstream\'s own fields, such as { "plan": "PRO" }.');
        }
        return engine.attach({ id: requiredIdArgument(args), app: String(args.app), own });
      },
      [names.delete]: (_parent, args) => engine.remove(requiredIdArgument(args)),
    },
  };
}

/**
 * Builds the executable subgraph that reads and writes a set of concepts across their member upstreams.
 *
 * @param concepts - Concepts that parsed with conceptSchema.
 * @param schemasByUpstream - Each member upstream's schema, by upstream name.
 * @param execute - Sends a request to an upstream by name, such as UpstreamService.execute.
 * @returns The schema: per concept a query, `create`, `update`, `attach` and `delete` mutations.
 * @throws ConceptValidationError when any member document does not fit its upstream's schema.
 */
export function createConceptSubgraph(
  concepts: readonly Concept[],
  schemasByUpstream: ReadonlyMap<string, GraphQLSchema>,
  execute: ExecuteUpstream,
): GraphQLSchema {
  const problems = validateConcepts(concepts, schemasByUpstream);
  if (problems.length > 0) {
    throw new ConceptValidationError(problems);
  }
  const built = concepts.map((concept) => ({ names: conceptNames(concept), ...conceptResolvers(concept, execute) }));
  const mutation = Object.assign({}, ...built.map((one) => one.mutation));
  const hasMutations = concepts.length > 0;
  return createSchema({
    typeDefs: generateConceptSdl(concepts, schemasByUpstream),
    resolvers: {
      JSON: JsonScalar,
      ...Object.fromEntries(built.map((one) => [one.names.app, one.app])),
      Query: Object.assign(
        { [SERVED_CONCEPTS_FIELD]: () => concepts.map((concept) => concept.name) },
        ...built.map((one) => one.query),
      ),
      ...(hasMutations ? { Mutation: mutation } : {}),
    },
  });
}
