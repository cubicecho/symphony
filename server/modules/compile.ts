// Checks a module's TSX against docs/module-contract.md and compiles it to the CommonJS-shaped code the
// browser runs. Every stage collects all the problems it finds, so one submit shows an agent everything.
import { parse as parseTsx } from '@babel/parser';
import type { File, Node, Program, StringLiteral } from '@babel/types';
import { transform } from 'esbuild';
import { GraphQLError, type GraphQLSchema, parse as parseGraphql, validate } from 'graphql';
import { MODULE_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { COMPONENT_PREFIX } from './allowlist.ts';
import {
  type CompileError,
  type CompileInput,
  type CompileResult,
  CompileStage,
  type CompileUpstream,
} from './compile-result.ts';
import {
  findGqlTemplates,
  type GqlTemplate,
  positionOf,
  type SourcePosition,
  toSourcePosition,
  visitNodes,
} from './gql-extract.ts';
import { findRouteProblems } from './route-check.ts';

const { maxSourceChars, maxDocuments } = MODULE_DEFAULTS;

/** What a module may import, in the short form error messages give. */
const ALLOWED_SUMMARY = 'react, symphony, @/lib/utils, or @/components/… (call list_components for the names)';

/** The `export { X as default }` name, and the `import.meta` meta-property name. */
const DEFAULT_EXPORT = 'default';
const IMPORT_KEYWORD = 'import';
const REQUIRE_FUNCTION = 'require';

/** What esbuild targets: the browsers the web app supports. */
const TRANSFORM_TARGET = 'es2022';

/** Babel ends its messages with "(line:column)", which the error's own fields already carry. */
const BABEL_POSITION_SUFFIX = /\s*\(\d+:\d+\)$/;

/** A Babel or esbuild failure carrying a position. */
interface LocatedFailure {
  message: string;
  loc: { line: number; column: number };
}

/** One esbuild message, as a failed `transform` lists them. */
interface EsbuildMessage {
  text: string;
  location: { line: number; column: number } | null;
}

/**
 * Checks and compiles one module.
 *
 * @param input - The source, its file name, the module's upstreams and the allowed imports.
 * @returns The errors found, the compiled code when there are none, and the GraphQL documents.
 */
export async function compileModule(input: CompileInput): Promise<CompileResult> {
  const isTooLong = input.source.length > maxSourceChars;
  if (isTooLong) {
    const message = `The source is ${input.source.length} characters; a module may be at most ${maxSourceChars}. Split it into smaller modules.`;
    return failed([sourceError(message, null)], []);
  }
  const parsed = parseSource(input.source);
  if ('error' in parsed) {
    return failed([parsed.error], []);
  }
  const { program } = parsed.file;
  const errors: CompileError[] = [...checkDefaultExport(program), ...checkImports(program, input.allowedImports)];
  const graphql = checkGraphql(program, input.upstreams);
  errors.push(...graphql.errors, ...checkRoutes(program));
  const hasErrors = errors.length > 0;
  if (hasErrors) {
    return failed(errors, graphql.documents);
  }
  const transformed = await transformSource(input.source, input.fileName);
  if ('errors' in transformed) {
    return failed(transformed.errors, graphql.documents);
  }
  return { ok: true, errors: [], compiled: transformed.code, documents: graphql.documents };
}

/**
 * Builds a failed result.
 *
 * @param errors - At least one error.
 * @param documents - The documents found before the failure.
 * @returns A result with `ok` false and no code.
 */
function failed(errors: CompileError[], documents: string[]): CompileResult {
  return { ok: false, errors, compiled: null, documents };
}

/**
 * Builds a SOURCE error.
 *
 * @param message - What is wrong and how to fix it.
 * @param position - Where, or null for the whole file.
 * @returns The error.
 */
function sourceError(message: string, position: SourcePosition | null): CompileError {
  return { stage: CompileStage.Source, message, line: position?.line ?? null, column: position?.column ?? null };
}

/**
 * Builds an error placed at a node.
 *
 * @param stage - The stage that found it.
 * @param message - What is wrong and how to fix it.
 * @param node - Where it is.
 * @returns The error.
 */
function errorAt(stage: CompileStage, message: string, node: Node): CompileError {
  const position = positionOf(node);
  return { stage, message, line: position?.line ?? null, column: position?.column ?? null };
}

/**
 * Checks that a thrown value carries a Babel-style location.
 *
 * @param error - Whatever the parser threw.
 * @returns True when it has a message and a `loc` with line and column.
 */
function isLocatedFailure(error: unknown): error is LocatedFailure {
  return (
    error instanceof Error &&
    'loc' in error &&
    typeof error.loc === 'object' &&
    error.loc !== null &&
    'line' in error.loc &&
    'column' in error.loc
  );
}

/**
 * Parses the TSX.
 *
 * @param source - The module's source.
 * @returns The AST, or a SOURCE error placed at the syntax error.
 */
function parseSource(source: string): { file: File } | { error: CompileError } {
  try {
    return { file: parseTsx(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }) };
  } catch (error) {
    if (isLocatedFailure(error)) {
      const message = `Syntax error: ${error.message.replace(BABEL_POSITION_SUFFIX, '')}.`;
      return { error: sourceError(message, { line: error.loc.line, column: error.loc.column + 1 }) };
    }
    return { error: sourceError(`Syntax error: ${errorMessage(error)}`, null) };
  }
}

/**
 * Checks that the module has a default export.
 *
 * @param program - The parsed module.
 * @returns One SOURCE error when there is none, else nothing.
 */
function checkDefaultExport(program: Program): CompileError[] {
  const hasDefault = program.body.some(
    (statement) =>
      statement.type === 'ExportDefaultDeclaration' ||
      (statement.type === 'ExportNamedDeclaration' &&
        statement.specifiers.some((specifier) =>
          specifier.exported.type === 'Identifier'
            ? specifier.exported.name === DEFAULT_EXPORT
            : specifier.exported.value === DEFAULT_EXPORT,
        )),
  );
  if (hasDefault) {
    return [];
  }
  return [
    sourceError(
      'The module has no default export. Export the component: `export default function MyModule() { return …; }`.',
      null,
    ),
  ];
}

/**
 * Explains why a specifier may not be imported.
 *
 * @param specifier - What the module tried to import.
 * @returns An actionable message.
 */
function disallowedImportMessage(specifier: string): string {
  const isRelative = specifier.startsWith('.') || specifier.startsWith('/');
  if (isRelative) {
    return `Relative import "${specifier}" is not allowed: a module is one file, so put that code in it. Modules may import only ${ALLOWED_SUMMARY}.`;
  }
  const isComponent = specifier.startsWith(COMPONENT_PREFIX);
  if (isComponent) {
    return `No component "${specifier}" is installed. Call list_components for the names you can import.`;
  }
  return `Cannot import "${specifier}": modules may import only ${ALLOWED_SUMMARY}.`;
}

/**
 * Checks every import, re-export, dynamic import, `require` and `import.meta` in the module.
 *
 * @param program - The parsed module.
 * @param allowedImports - The specifiers modules may import.
 * @returns One IMPORTS error per offending place.
 *
 * @remarks
 * `import type` is held to the same list. Type-position `import('x')` types are erased, so they pass.
 */
function checkImports(program: Program, allowedImports: ReadonlySet<string>): CompileError[] {
  const errors: CompileError[] = [];
  const checkSpecifier = (source: StringLiteral) => {
    const isAllowed = allowedImports.has(source.value);
    if (isAllowed === false) {
      errors.push(errorAt(CompileStage.Imports, disallowedImportMessage(source.value), source));
    }
  };
  visitNodes(program, (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') {
      checkSpecifier(node.source);
    } else if (node.type === 'ExportNamedDeclaration' && node.source != null) {
      checkSpecifier(node.source);
    } else if (node.type === 'ImportExpression') {
      const message = `Dynamic import() is not allowed. Import statically at the top of the file from ${ALLOWED_SUMMARY}.`;
      errors.push(errorAt(CompileStage.Imports, message, node));
    } else if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === REQUIRE_FUNCTION
    ) {
      const message = `require() is not allowed. Use a static import from ${ALLOWED_SUMMARY}.`;
      errors.push(errorAt(CompileStage.Imports, message, node));
    } else if (node.type === 'MetaProperty' && node.meta.name === IMPORT_KEYWORD) {
      errors.push(errorAt(CompileStage.Imports, 'import.meta is not available to modules. Remove it.', node));
    } else if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') {
      const message = `\`import … = require()\` is not allowed. Use a static import from ${ALLOWED_SUMMARY}.`;
      errors.push(errorAt(CompileStage.Imports, message, node));
    }
  });
  return errors;
}

/**
 * Finds the name of a document's first operation, for messages.
 *
 * @param text - The document text.
 * @param index - The document's place in the module, from 0.
 * @returns `query RecentOrders`, or `GraphQL document 2` when it has no name or does not parse.
 */
function documentLabel(text: string, index: number): string {
  const match = /\b(query|mutation|subscription|fragment)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(text);
  return match === null ? `GraphQL document ${index + 1}` : `${match[1]} ${match[2]}`;
}

/**
 * Turns a GraphQL error into a GRAPHQL error placed in the TSX.
 *
 * @param error - From `parse` or `validate`.
 * @param template - The template the document came from.
 * @param label - The document's name for the message.
 * @returns The error.
 */
function graphqlError(error: GraphQLError, template: GqlTemplate, label: string): CompileError {
  const [location] = error.locations ?? [];
  const position = location === undefined ? template.start : toSourcePosition(template, location);
  return { stage: CompileStage.Graphql, message: `In ${label}: ${error.message}`, ...position };
}

/**
 * Checks one document: it parses, and validates when there is a schema.
 *
 * @param template - Its template, with text.
 * @param text - The document text.
 * @param index - Its place in the module, from 0.
 * @param schema - Its upstream's schema, or null to check the syntax only.
 * @returns The GRAPHQL errors.
 */
function checkDocument(
  template: GqlTemplate,
  text: string,
  index: number,
  schema: GraphQLSchema | null,
): CompileError[] {
  const label = documentLabel(text, index);
  try {
    const document = parseGraphql(text);
    if (schema === null) {
      return [];
    }
    return validate(schema, document).map((error) => graphqlError(error, template, label));
  } catch (error) {
    if (error instanceof GraphQLError) {
      return [graphqlError(error, template, label)];
    }
    return [{ stage: CompileStage.Graphql, message: `In ${label}: ${errorMessage(error)}`, ...template.start }];
  }
}

/**
 * Finds the upstream a document is for.
 *
 * @param name - The name `gql.from` passed, or null for a plain `gql`.
 * @param upstreams - The module's upstreams, the default first.
 * @returns The upstream, or undefined when the module does not read one by that name.
 */
function upstreamFor(name: string | null, upstreams: readonly CompileUpstream[]): CompileUpstream | undefined {
  return name === null ? upstreams[0] : upstreams.find((upstream) => upstream.name === name);
}

/**
 * Explains a `gql.from` name the module does not read.
 *
 * @param name - The name.
 * @param upstreams - The module's upstreams.
 * @returns An actionable message.
 */
function unknownUpstreamMessage(name: string, upstreams: readonly CompileUpstream[]): string {
  const names = upstreams.map((upstream) => `"${upstream.name}"`).join(', ');
  return `gql.from('${name}') names an upstream this module does not read. Its upstreams are ${names}: use one of those names, or add "${name}" to the module's upstreams (list_upstreams names them all).`;
}

/**
 * Checks every `gql` document in the module, each against its own upstream's schema.
 *
 * @param program - The parsed module.
 * @param upstreams - The module's upstreams, the default first.
 * @returns The GRAPHQL errors, and the text of each document without `${…}`, in source order.
 */
function checkGraphql(
  program: Program,
  upstreams: readonly CompileUpstream[],
): { errors: CompileError[]; documents: string[] } {
  const { templates, misuses } = findGqlTemplates(program);
  const errors: CompileError[] = misuses.map((misuse) => ({
    stage: CompileStage.Graphql,
    message: misuse.message,
    line: misuse.position?.line ?? null,
    column: misuse.position?.column ?? null,
  }));
  const documents: string[] = [];
  const firstExtra = templates[maxDocuments];
  if (firstExtra !== undefined) {
    const message = `The module has ${templates.length} gql documents; a module may have at most ${maxDocuments}. Split it into smaller modules.`;
    errors.push({ stage: CompileStage.Graphql, message, ...firstExtra.start });
  }
  for (const [index, template] of templates.entries()) {
    const { text, interpolation } = template;
    const upstream = upstreamFor(template.upstream, upstreams);
    if (text === null) {
      const message = `GraphQL document ${index + 1} contains \${…}. Write the document as plain text and pass values as variables ($name in the document, { variables } in useQuery or mutate).`;
      errors.push({ stage: CompileStage.Graphql, message, ...(interpolation ?? template.start) });
    } else {
      documents.push(text);
      if (upstream === undefined && template.upstream !== null) {
        errors.push({
          stage: CompileStage.Graphql,
          message: unknownUpstreamMessage(template.upstream, upstreams),
          ...template.start,
        });
      }
      errors.push(...checkDocument(template, text, index, upstream?.schema ?? null));
    }
  }
  return { errors, documents };
}

/**
 * Checks the module's literal route paths against the routes its `Routes` declare.
 *
 * @param program - The parsed module.
 * @returns The ROUTES errors, in source order.
 */
function checkRoutes(program: Program): CompileError[] {
  return findRouteProblems(program).map((problem) => ({
    stage: CompileStage.Routes,
    message: problem.message,
    line: problem.position?.line ?? null,
    column: problem.position?.column ?? null,
  }));
}

/**
 * Checks that a thrown value is an esbuild failure listing its messages.
 *
 * @param error - Whatever `transform` threw.
 * @returns True when it has an `errors` array.
 */
function isEsbuildFailure(error: unknown): error is { errors: EsbuildMessage[] } {
  return typeof error === 'object' && error !== null && 'errors' in error && Array.isArray(error.errors);
}

/**
 * Compiles the TSX to CommonJS-shaped browser code with an inline source map.
 *
 * @param source - The module's source, already checked.
 * @param fileName - The name source maps and stack traces show.
 * @returns The code, or TRANSFORM errors.
 */
async function transformSource(
  source: string,
  fileName: string,
): Promise<{ code: string } | { errors: CompileError[] }> {
  try {
    const result = await transform(source, {
      loader: 'tsx',
      format: 'cjs',
      jsx: 'automatic',
      target: TRANSFORM_TARGET,
      sourcemap: 'inline',
      sourcefile: `${fileName}.tsx`,
    });
    return { code: `${result.code}\n//# sourceURL=symphony-module/${fileName}.js\n` };
  } catch (error) {
    if (isEsbuildFailure(error)) {
      return {
        errors: error.errors.map((message) => ({
          stage: CompileStage.Transform,
          message: message.text,
          line: message.location?.line ?? null,
          column: message.location === null ? null : message.location.column + 1,
        })),
      };
    }
    return { errors: [{ stage: CompileStage.Transform, message: errorMessage(error), line: null, column: null }] };
  }
}
