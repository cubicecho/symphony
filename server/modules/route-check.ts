// Checks a module's literal route paths against its route table: every `<RouteLink to="…">` and `navigate('…')` with
// a path the compiler can read must match a route declared in `<Routes routes={{…}}>`. The browser matches paths by
// the same rule (web/src/modules/route-match.ts); tests/modules/route-check.test.ts holds the two together.
import type { Expression, JSXOpeningElement, Node, ObjectExpression, Program } from '@babel/types';
import {
  isRuntimeReference,
  positionOf,
  type RuntimeBindings,
  runtimeBindings,
  type SourcePosition,
  visitNodes,
} from './gql-extract.ts';

/** The runtime exports the check follows. */
const ROUTES_EXPORT = 'Routes';
const ROUTE_LINK_EXPORT = 'RouteLink';
const USE_ROUTE_EXPORT = 'useRoute';
/** The props and members that carry a route table or a path. */
const ROUTES_PROP = 'routes';
const TO_PROP = 'to';
const NAVIGATE_MEMBER = 'navigate';

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
 * Finds the module's top-level `const NAME = { … }` objects, for a route table passed by name.
 *
 * @param program - The parsed module.
 * @returns Each object literal by its name.
 */
function topLevelObjects(program: Program): Map<string, ObjectExpression> {
  const objects = new Map<string, ObjectExpression>();
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
      for (const declarator of declaration.declarations) {
        const init = declarator.init == null ? null : unwrapped(declarator.init);
        if (declarator.id.type === 'Identifier' && init?.type === 'ObjectExpression') {
          objects.set(declarator.id.name, init);
        }
      }
    }
  }
  return objects;
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
 * Tells whether a JSX element is one of the runtime's components.
 *
 * @param element - The opening tag.
 * @param bindings - The names the component was imported under.
 * @returns True for `<Routes>`, an aliased name, or `<runtime.Routes>`.
 */
function isRuntimeElement(element: JSXOpeningElement, bindings: RuntimeBindings): boolean {
  const { name } = element;
  if (name.type === 'JSXIdentifier') {
    return bindings.direct.has(name.name);
  }
  return (
    name.type === 'JSXMemberExpression' &&
    name.object.type === 'JSXIdentifier' &&
    bindings.namespaces.has(name.object.name) &&
    name.property.name === bindings.exportName
  );
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
 * @param program - The parsed module.
 * @returns Each path the compiler can read, and the route tables it declares.
 */
function collect(program: Program): { tables: RouteTable[]; uses: PathUse[] } {
  const routesBindings = runtimeBindings(program, ROUTES_EXPORT);
  const linkBindings = runtimeBindings(program, ROUTE_LINK_EXPORT);
  const useRouteBindings = runtimeBindings(program, USE_ROUTE_EXPORT);
  const objects = topLevelObjects(program);
  const tables: RouteTable[] = [];
  const uses: PathUse[] = [];
  /** Names `navigate` was destructured into, and names holding a `useRoute()` result. */
  const navigateNames = new Set<string>();
  const routeNames = new Set<string>();
  const navigateCalls: { callee: Node; argument: Node }[] = [];

  const isUseRouteCall = (node: Node): boolean =>
    node.type === 'CallExpression' && isRuntimeReference(node.callee, useRouteBindings);

  visitNodes(program, (node) => {
    if (node.type === 'JSXOpeningElement' && isRuntimeElement(node, routesBindings)) {
      const value = propValue(node, ROUTES_PROP);
      const object = value?.type === 'Identifier' ? objects.get(value.name) : value;
      tables.push(object?.type === 'ObjectExpression' ? routesOf(object) : { routes: [], isKnown: false });
    } else if (node.type === 'JSXOpeningElement' && isRuntimeElement(node, linkBindings)) {
      const value = propValue(node, TO_PROP);
      const use = value === null ? null : pathUseOf(value, `RouteLink ${TO_PROP}`);
      if (use !== null) {
        uses.push(use);
      }
    } else if (node.type === 'VariableDeclarator' && node.init != null && isUseRouteCall(node.init)) {
      if (node.id.type === 'Identifier') {
        routeNames.add(node.id.name);
      } else if (node.id.type === 'ObjectPattern') {
        for (const property of node.id.properties) {
          const isNavigate =
            property.type === 'ObjectProperty' &&
            property.computed === false &&
            property.key.type === 'Identifier' &&
            property.key.name === NAVIGATE_MEMBER;
          if (isNavigate && property.value.type === 'Identifier') {
            navigateNames.add(property.value.name);
          }
        }
      }
    } else if (node.type === 'CallExpression' && node.arguments[0] !== undefined) {
      navigateCalls.push({ callee: node.callee, argument: node.arguments[0] });
    }
  });

  for (const { callee, argument } of navigateCalls) {
    const isDestructured = callee.type === 'Identifier' && navigateNames.has(callee.name);
    const isMember =
      callee.type === 'MemberExpression' &&
      callee.computed === false &&
      callee.property.type === 'Identifier' &&
      callee.property.name === NAVIGATE_MEMBER &&
      ((callee.object.type === 'Identifier' && routeNames.has(callee.object.name)) || isUseRouteCall(callee.object));
    const use = isDestructured || isMember ? pathUseOf(argument, NAVIGATE_MEMBER) : null;
    if (use !== null) {
      uses.push(use);
    }
  }
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
 * @param program - The parsed module.
 * @returns The problems, in source order. A module with no `Routes`, or one whose table can't be read, has its paths
 * left unchecked.
 */
export function findRouteProblems(program: Program): RouteProblem[] {
  const { tables, uses } = collect(program);
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
