// Checks a module's literal route paths against its route table: every `<RouteLink to="…">` and `navigate('…')` with
// a path the compiler can read must match a route declared in `<Routes routes={{…}}>`. The browser matches paths by
// the same rule (web/src/modules/route-match.ts); tests/modules/route-check.test.ts holds the two together.
import traverse, { type Scope } from '@babel/traverse';
import type { Expression, File, JSXOpeningElement, Node, ObjectExpression } from '@babel/types';
import { positionOf, RUNTIME_SPECIFIER, type SourcePosition } from './gql-extract.ts';

/** The runtime exports the check follows. */
const ROUTES_EXPORT = 'Routes';
const ROUTE_LINK_EXPORT = 'RouteLink';
const USE_ROUTE_EXPORT = 'useRoute';
/** The props and members that carry a route table or a path. */
const ROUTES_PROP = 'routes';
const TO_PROP = 'to';
const NAVIGATE_MEMBER = 'navigate';
/** What `runtimeImportOf` gives for `import * as runtime from 'symphony'`. */
const NAMESPACE_IMPORT = '*';

/** What starts a parameter segment in a route: `/orders/:id`. */
const PARAM_PREFIX = ':';
/** Every module path starts here. */
const ROOT_PATH = '/';
/** Stands in for a `${…}` while a template's path is split into segments. Never in a path's own text. */
const INTERPOLATION = '\u0000';
/** How a `${…}` is shown in messages. */
const INTERPOLATION_DISPLAY = `\${…}`;

/** A path that matches no route, or a route that is not a path. */
export interface RouteProblem {
  message: string;
  position: SourcePosition | null;
}

/** A path the module goes to, as far as the compiler can read it. */
interface PathUse {
  /** The path, each `${…}` replaced by `INTERPOLATION`. */
  text: string;
  /** How the path is written, for messages: `"/orders"` or `` `/orders/${…}` ``. */
  display: string;
  /** `RouteLink to` or `navigate`, for messages. */
  via: string;
  node: Node;
}

/** One route in a table, and the key that declares it. */
interface DeclaredRoute {
  route: string;
  node: Node;
}

/** The routes a module's `Routes` declare. */
interface RouteTable {
  routes: DeclaredRoute[];
  /** False when a table is built in a way the compiler can't read (a spread, a computed key, a call). */
  isKnown: boolean;
}

/**
 * Strips the type syntax around an expression: `{…} as const`, `{…} satisfies Routes`.
 *
 * @param node - The expression.
 * @returns The expression inside.
 */
function unwrapped(node: Expression): Expression {
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') {
    return unwrapped(node.expression);
  }
  return node;
}

/**
 * Finds what a name is bound to where it is used, when that is an import from the runtime.
 *
 * @param scope - The scope the name is used in.
 * @param name - The name.
 * @returns The runtime export it names, `NAMESPACE_IMPORT` for `import * as runtime`, or null when the name is
 * bound to something else there (a local that shadows the import, say) or to nothing.
 */
function runtimeImportOf(scope: Scope, name: string): string | null {
  const binding = scope.getBinding(name);
  if (binding === undefined) {
    return null;
  }
  const specifier = binding.path.node;
  const declaration = binding.path.parent;
  const isRuntimeImport = declaration?.type === 'ImportDeclaration' && declaration.source.value === RUNTIME_SPECIFIER;
  if (isRuntimeImport === false) {
    return null;
  }
  if (specifier.type === 'ImportNamespaceSpecifier') {
    return NAMESPACE_IMPORT;
  }
  if (specifier.type === 'ImportSpecifier') {
    return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
  }
  return null;
}

/**
 * Tells whether an expression or a JSX tag name is one of the runtime's exports, where it is used.
 *
 * @param scope - The scope it is used in.
 * @param node - The expression or tag name.
 * @param exportName - The export.
 * @returns True for `Routes`, an aliased name, or `runtime.Routes`, each bound to the runtime's import.
 */
function isRuntimeExport(scope: Scope, node: Node, exportName: string): boolean {
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') {
    return runtimeImportOf(scope, node.name) === exportName;
  }
  if (node.type === 'MemberExpression' && node.computed === false && node.object.type === 'Identifier') {
    const isNamed = node.property.type === 'Identifier' && node.property.name === exportName;
    return isNamed && runtimeImportOf(scope, node.object.name) === NAMESPACE_IMPORT;
  }
  if (node.type === 'JSXMemberExpression' && node.object.type === 'JSXIdentifier') {
    return node.property.name === exportName && runtimeImportOf(scope, node.object.name) === NAMESPACE_IMPORT;
  }
  return false;
}

/**
 * Tells whether an expression is a `useRoute()` call.
 *
 * @param scope - The scope it is in.
 * @param node - The expression.
 * @returns True for a call of the runtime's `useRoute`.
 */
function isUseRouteCall(scope: Scope, node: Node): boolean {
  return node.type === 'CallExpression' && isRuntimeExport(scope, node.callee, USE_ROUTE_EXPORT);
}

/**
 * Finds what a name holds when it was declared from `useRoute()`.
 *
 * @param scope - The scope the name is used in.
 * @param name - The name.
 * @returns `result` for `const route = useRoute()`, `navigate` for `const { navigate } = useRoute()` (renamed or
 * not), or null when the name, where it is used, is bound to anything else.
 */
function useRouteBindingOf(scope: Scope, name: string): 'result' | 'navigate' | null {
  const binding = scope.getBinding(name);
  const declarator = binding?.path.node;
  if (binding === undefined || binding.constant === false || declarator?.type !== 'VariableDeclarator') {
    return null;
  }
  const isFromUseRoute = declarator.init != null && isUseRouteCall(binding.path.scope, unwrapped(declarator.init));
  if (isFromUseRoute === false) {
    return null;
  }
  if (declarator.id.type === 'Identifier') {
    return 'result';
  }
  const isNavigate =
    declarator.id.type === 'ObjectPattern' &&
    declarator.id.properties.some(
      (property) =>
        property.type === 'ObjectProperty' &&
        property.computed === false &&
        property.key.type === 'Identifier' &&
        property.key.name === NAVIGATE_MEMBER &&
        property.value.type === 'Identifier' &&
        property.value.name === name,
    );
  return isNavigate ? 'navigate' : null;
}

/**
 * Tells whether a call's callee is the `navigate` of a `useRoute()`.
 *
 * @param scope - The scope the call is in.
 * @param callee - The callee.
 * @returns True for `navigate(…)` destructured from `useRoute()`, `route.navigate(…)` on its result, and
 * `useRoute().navigate(…)`.
 */
function isNavigateCallee(scope: Scope, callee: Node): boolean {
  if (callee.type === 'Identifier') {
    return useRouteBindingOf(scope, callee.name) === 'navigate';
  }
  const isNavigateMember =
    callee.type === 'MemberExpression' &&
    callee.computed === false &&
    callee.property.type === 'Identifier' &&
    callee.property.name === NAVIGATE_MEMBER;
  if (isNavigateMember === false) {
    return false;
  }
  const { object } = callee;
  if (object.type === 'Identifier') {
    return useRouteBindingOf(scope, object.name) === 'result';
  }
  return isUseRouteCall(scope, object);
}

/**
 * Finds the object literal a `const` holds, for a route table passed by name.
 *
 * @param scope - The scope the name is used in.
 * @param name - The name.
 * @returns The object, or null when the name, where it is used, is bound to anything but a `const` object literal.
 */
function constObjectOf(scope: Scope, name: string): ObjectExpression | null {
  const binding = scope.getBinding(name);
  const declarator = binding?.path.node;
  if (binding?.kind !== 'const' || declarator?.type !== 'VariableDeclarator' || declarator.init == null) {
    return null;
  }
  const init = unwrapped(declarator.init);
  return init.type === 'ObjectExpression' ? init : null;
}

/**
 * Reads the routes an object literal declares.
 *
 * @param object - The `routes` table.
 * @returns Its keys, and whether every key could be read.
 */
function routesOf(object: ObjectExpression): RouteTable {
  const routes: DeclaredRoute[] = [];
  let isKnown = true;
  for (const property of object.properties) {
    const key = property.type === 'SpreadElement' || property.computed ? null : property.key;
    if (key?.type === 'StringLiteral') {
      routes.push({ route: key.value, node: key });
    } else if (key?.type === 'Identifier') {
      routes.push({ route: key.name, node: key });
    } else {
      isKnown = false;
    }
  }
  return { routes, isKnown };
}

/**
 * Finds a prop's value on a JSX element.
 *
 * @param element - The opening tag.
 * @param prop - The prop's name.
 * @returns The string literal or the expression it is set to, or null when it is not set to one.
 */
function propValue(element: JSXOpeningElement, prop: string): Expression | null {
  for (const attribute of element.attributes) {
    if (attribute.type === 'JSXAttribute' && attribute.name.name === prop) {
      const { value } = attribute;
      if (value?.type === 'StringLiteral') {
        return value;
      }
      if (value?.type === 'JSXExpressionContainer' && value.expression.type !== 'JSXEmptyExpression') {
        return unwrapped(value.expression);
      }
      return null;
    }
  }
  return null;
}

/**
 * Reads a path the compiler can follow.
 *
 * @param node - What a `to` or `navigate` is given.
 * @param via - Where it was given, for messages.
 * @returns The path, or null when it is not a string literal or a template literal.
 */
function pathUseOf(node: Node, via: string): PathUse | null {
  if (node.type === 'StringLiteral') {
    return { text: node.value, display: `"${node.value}"`, via, node };
  }
  if (node.type === 'TemplateLiteral') {
    const parts = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
    return { text: parts.join(INTERPOLATION), display: `\`${parts.join(INTERPOLATION_DISPLAY)}\``, via, node };
  }
  return null;
}

/**
 * Tells whether one segment of a path fits one segment of a route. A `${…}` segment fits only a `:param` one.
 *
 * @param routeSegment - The route's segment.
 * @param pathSegment - The path's segment.
 * @returns True when it fits.
 */
function segmentFits(routeSegment: string, pathSegment: string): boolean {
  if (routeSegment.startsWith(PARAM_PREFIX)) {
    return true;
  }
  return pathSegment.includes(INTERPOLATION) === false && routeSegment === pathSegment;
}

/**
 * Splits a path into its segments, ignoring a trailing slash.
 *
 * @param path - `/orders/o3`.
 * @returns `['orders', 'o3']`, or `[]` for the root.
 */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Tells whether a path fits a route.
 *
 * @param route - The route, as declared.
 * @param path - The path, `${…}` marked.
 * @returns True when it fits.
 */
export function pathFitsRoute(route: string, path: string): boolean {
  const routeSegments = segmentsOf(route);
  const pathSegments = segmentsOf(path);
  return (
    routeSegments.length === pathSegments.length &&
    routeSegments.every((segment, index) => segmentFits(segment, pathSegments[index] ?? ''))
  );
}

/**
 * Finds the paths a module goes to: `RouteLink to`, and `navigate` from `useRoute()`, destructured or not.
 *
 * Names are resolved where they are used, so a local that shadows an import or a table is not mistaken for it.
 *
 * @param file - The parsed module.
 * @returns Each path the compiler can read, and the route tables it declares.
 */
function collect(file: File): { tables: RouteTable[]; uses: PathUse[] } {
  const tables: RouteTable[] = [];
  const uses: PathUse[] = [];
  traverse(file, {
    JSXOpeningElement(path) {
      const { node, scope } = path;
      if (isRuntimeExport(scope, node.name, ROUTES_EXPORT)) {
        const value = propValue(node, ROUTES_PROP);
        const object = value?.type === 'Identifier' ? constObjectOf(scope, value.name) : value;
        tables.push(object?.type === 'ObjectExpression' ? routesOf(object) : { routes: [], isKnown: false });
      } else if (isRuntimeExport(scope, node.name, ROUTE_LINK_EXPORT)) {
        const value = propValue(node, TO_PROP);
        const use = value === null ? null : pathUseOf(value, `RouteLink ${TO_PROP}`);
        if (use !== null) {
          uses.push(use);
        }
      }
    },
    CallExpression(path) {
      const { node, scope } = path;
      const [argument] = node.arguments;
      const use =
        argument !== undefined && isNavigateCallee(scope, node.callee) ? pathUseOf(argument, NAVIGATE_MEMBER) : null;
      if (use !== null) {
        uses.push(use);
      }
    },
  });
  return { tables, uses };
}

/**
 * Explains a path no route matches.
 *
 * @param use - The path.
 * @param routes - The module's routes.
 * @returns An actionable message.
 */
function unmatchedMessage(use: PathUse, routes: readonly string[]): string {
  const declared = routes.map((route) => `"${route}"`).join(', ');
  return `${use.via} ${use.display} matches no route in this module's Routes. Its routes are ${declared}: fix the path, or add a route for it (a \${…} stands for one :param segment).`;
}

/**
 * Checks every route the module declares, and every path it goes to that the compiler can read.
 *
 * @param file - The parsed module.
 * @returns The problems, in source order. A module with no `Routes`, or one whose table can't be read, has its paths
 * left unchecked.
 */
export function findRouteProblems(file: File): RouteProblem[] {
  const { tables, uses } = collect(file);
  const problems: { problem: RouteProblem; offset: number }[] = [];
  const declared = tables.flatMap((table) => table.routes);
  const routes = declared.map(({ route }) => route);
  const isTableKnown = tables.length > 0 && tables.every((table) => table.isKnown);

  for (const { route, node } of declared) {
    if (route.startsWith(ROOT_PATH) === false) {
      const message = `Route "${route}" in Routes is not a module path. Start it with "/", as in "/${route}".`;
      problems.push({ problem: { message, position: positionOf(node) }, offset: node.start ?? 0 });
    }
  }
  for (const use of uses) {
    const isLiteral = use.text.includes(INTERPOLATION) === false;
    const startsAtRoot = use.text.startsWith(ROOT_PATH);
    const position = positionOf(use.node);
    const offset = use.node.start ?? 0;
    if (isLiteral && startsAtRoot === false) {
      const message = `${use.via} ${use.display} is not a module path. Start it with "/", as in "/${use.text}": paths are the module's own.`;
      problems.push({ problem: { message, position }, offset });
    } else if (isTableKnown && startsAtRoot && routes.some((route) => pathFitsRoute(route, use.text)) === false) {
      problems.push({ problem: { message: unmatchedMessage(use, routes), position }, offset });
    }
  }
  return problems.toSorted((a, b) => a.offset - b.offset).map(({ problem }) => problem);
}
