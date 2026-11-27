// Finds a module's GraphQL documents: the templates tagged with `gql` or `gql.from('<upstream>')` from 'symphony',
// which upstream each one is for, and where each one sits in the TSX, so a GraphQL error can point at the line and
// column in the module's own file.
import type { CallExpression, Node, Program, TaggedTemplateExpression } from '@babel/types';

/** The specifier the runtime, and so `gql`, is imported from. */
export const RUNTIME_SPECIFIER = 'symphony';

/** The export that marks a GraphQL document. */
const GQL_EXPORT = 'gql';

/** The method on `gql` that names another of the module's upstreams: `gql.from('billing')`. */
const FROM_METHOD = 'from';

/** Node keys that hold positions, comments and parser notes, never child nodes worth visiting. */
const SKIPPED_KEYS = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments']);

/** A place in the TSX source. Both count from 1. */
export interface SourcePosition {
  line: number;
  column: number;
}

/** One `gql` tagged template found in a module. */
export interface GqlTemplate {
  /** The document's text, or null when the template has `${…}` in it. */
  text: string | null;
  /** Where the first `${…}` expression starts, when there is one. */
  interpolation: SourcePosition | null;
  /** Where the template's first character (just after the backtick) is. */
  start: SourcePosition;
  /** Offset of the template in the source, for ordering. */
  offset: number;
  /** The upstream named by `gql.from('<name>')`, or null for a plain `gql`, which goes to the module's default. */
  upstream: string | null;
}

/** A use of `gql.from` the compiler can't follow: not a string literal, or not used as a template's tag. */
export interface GqlMisuse {
  message: string;
  position: SourcePosition | null;
}

/** What a module's `gql` uses come to. */
export interface GqlUses {
  /** Every document, in source order. */
  templates: GqlTemplate[];
  /** The `gql.from` calls that name no upstream the compiler can know. */
  misuses: GqlMisuse[];
}

/** The local names `gql` is reachable by. */
interface GqlBindings {
  /** Names bound by `import { gql }` or `import { gql as g }`. */
  direct: Set<string>;
  /** Names bound by `import * as runtime`, used as `runtime.gql`. */
  namespaces: Set<string>;
}

/**
 * Checks that a value is a Babel AST node.
 *
 * @param value - Anything found on a node.
 * @returns True when it is an object with a string `type`.
 */
function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

/**
 * Calls a visitor on every node under a root, the root included, parents before children.
 *
 * @param root - Where to start.
 * @param visit - Called once per node.
 */
export function visitNodes(root: Node, visit: (node: Node) => void): void {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value.toReversed());
    } else if (isNode(value)) {
      visit(value);
      const children = Object.entries(value).filter(([key]) => SKIPPED_KEYS.has(key) === false);
      for (const [, child] of children.toReversed()) {
        if (typeof child === 'object' && child !== null) {
          pending.push(child);
        }
      }
    }
  }
}

/**
 * Reads where a node starts.
 *
 * @param node - Any parsed node.
 * @returns Its 1-based line and column, or null when the parser gave it no location.
 */
export function positionOf(node: Node): SourcePosition | null {
  if (node.loc == null) {
    return null;
  }
  return { line: node.loc.start.line, column: node.loc.start.column + 1 };
}

/**
 * Finds the local names a module imported `gql` from 'symphony' under.
 *
 * @param program - The parsed module.
 * @returns The direct and namespace bindings.
 */
function gqlBindings(program: Program): GqlBindings {
  const bindings: GqlBindings = { direct: new Set(), namespaces: new Set() };
  for (const statement of program.body) {
    const isRuntimeImport = statement.type === 'ImportDeclaration' && statement.source.value === RUNTIME_SPECIFIER;
    if (isRuntimeImport) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') {
          bindings.namespaces.add(specifier.local.name);
        } else if (specifier.type === 'ImportSpecifier') {
          const imported =
            specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
          if (imported === GQL_EXPORT) {
            bindings.direct.add(specifier.local.name);
          }
        }
      }
    }
  }
  return bindings;
}

/**
 * Tells whether an expression is the runtime's `gql`.
 *
 * @param node - The expression.
 * @param bindings - The names `gql` was imported under.
 * @returns True for `gql`, an aliased name, or `runtime.gql`.
 */
function isGqlReference(node: Node, bindings: GqlBindings): boolean {
  if (node.type === 'Identifier') {
    return bindings.direct.has(node.name);
  }
  return (
    node.type === 'MemberExpression' &&
    node.computed === false &&
    node.object.type === 'Identifier' &&
    bindings.namespaces.has(node.object.name) &&
    node.property.type === 'Identifier' &&
    node.property.name === GQL_EXPORT
  );
}

/**
 * Tells whether a call is `gql.from(…)`.
 *
 * @param node - The call.
 * @param bindings - The names `gql` was imported under.
 * @returns True for `gql.from(…)`, on an aliased or namespaced `gql` too.
 */
function isFromCall(node: CallExpression, bindings: GqlBindings): boolean {
  const { callee } = node;
  return (
    callee.type === 'MemberExpression' &&
    callee.computed === false &&
    callee.property.type === 'Identifier' &&
    callee.property.name === FROM_METHOD &&
    isGqlReference(callee.object, bindings)
  );
}

/**
 * Reads the upstream name a `gql.from` call passes.
 *
 * @param node - The call.
 * @returns The name, or null when the call does not pass exactly one string literal.
 */
function fromName(node: CallExpression): string | null {
  const [argument] = node.arguments;
  const isLiteral = node.arguments.length === 1 && argument?.type === 'StringLiteral';
  return isLiteral ? argument.value : null;
}

/**
 * Finds every `gql` and `gql.from('<upstream>')` template from 'symphony' in a module, in source order.
 *
 * @param program - The parsed module.
 * @returns The templates, and the `gql.from` calls that are not a template's tag with a string literal. A template
 * tagged by some other `gql` is left out.
 */
export function findGqlTemplates(program: Program): GqlUses {
  const bindings = gqlBindings(program);
  const templates: GqlTemplate[] = [];
  const misuses: GqlMisuse[] = [];
  const tagCalls = new Set<Node>();
  const fromCalls: CallExpression[] = [];
  visitNodes(program, (node) => {
    if (node.type === 'CallExpression' && isFromCall(node, bindings)) {
      fromCalls.push(node);
      return;
    }
    if (node.type !== 'TaggedTemplateExpression') {
      return;
    }
    const upstream = tagUpstream(node, bindings);
    if (upstream === undefined) {
      return;
    }
    if (node.tag.type === 'CallExpression') {
      tagCalls.add(node.tag);
    }
    const { quasis, expressions } = node.quasi;
    const [first] = quasis;
    const firstExpression = expressions[0];
    const start = first === undefined ? null : positionOf(first);
    if (first === undefined || start === null) {
      return;
    }
    const hasInterpolation = firstExpression !== undefined;
    templates.push({
      text: hasInterpolation ? null : (first.value.cooked ?? first.value.raw),
      interpolation: hasInterpolation ? positionOf(firstExpression) : null,
      start,
      offset: node.start ?? 0,
      upstream,
    });
  });
  for (const call of fromCalls) {
    const position = positionOf(call);
    if (fromName(call) === null) {
      const message =
        "gql.from takes the upstream's name as one string literal, such as gql.from('billing')`…`, so the compiler knows which schema to check the document against.";
      misuses.push({ message, position });
    } else if (tagCalls.has(call) === false) {
      const message =
        "Use gql.from('…') directly as a template's tag, as in gql.from('billing')`query …`, so the compiler finds the document and checks it against that upstream.";
      misuses.push({ message, position });
    }
  }
  return {
    templates: templates.toSorted((a, b) => a.offset - b.offset),
    misuses: misuses.toSorted((a, b) => (a.position?.line ?? 0) - (b.position?.line ?? 0)),
  };
}

/**
 * Tells which upstream a tagged template is for, if its tag is the runtime's `gql`.
 *
 * @param node - The tagged template.
 * @param bindings - The names `gql` was imported under.
 * @returns Null for a plain `gql`, the name for `gql.from('<name>')`, or undefined when the tag is something else
 * (a `gql.from` call without a string literal is something else too; it is reported as a misuse).
 */
function tagUpstream(node: TaggedTemplateExpression, bindings: GqlBindings): string | null | undefined {
  const { tag } = node;
  if (tag.type === 'CallExpression') {
    return isFromCall(tag, bindings) ? (fromName(tag) ?? undefined) : undefined;
  }
  return isGqlReference(tag, bindings) ? null : undefined;
}

/**
 * Maps a place inside a template's text to the same place in the TSX source.
 *
 * @param template - The template the text came from.
 * @param location - A 1-based line and column within the text, as a GraphQL error gives it.
 * @returns The 1-based line and column in the TSX file.
 *
 * @remarks
 * Exact when the text has no escape sequences, since the cooked text is what GraphQL saw.
 */
export function toSourcePosition(template: GqlTemplate, location: SourcePosition): SourcePosition {
  const isFirstLine = location.line === 1;
  if (isFirstLine) {
    return { line: template.start.line, column: template.start.column + location.column - 1 };
  }
  return { line: template.start.line + location.line - 1, column: location.column };
}
