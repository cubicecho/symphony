// Matches a module's path to its route table: the pure half of the runtime's `Routes`. The compiler checks literal
// paths by the same rule (server/modules/route-check.ts); tests/modules/route-check.test.ts holds the two together.

/** What starts a parameter segment in a route: `/orders/:id`. */
export const PARAM_PREFIX = ':';

/** The path a module starts on, and goes back to when its path is cleared. */
export const ROOT_PATH = '/';

/** A route that matched a path, with the values its `:param` segments took. */
export interface RouteMatch {
  /** The route as the table declares it: `/orders/:id`. */
  route: string;
  /** Each parameter's value, decoded: `{ id: 'o3' }` for `/orders/o3`. */
  params: Record<string, string>;
}

/**
 * Splits a path into its segments, ignoring a trailing slash.
 *
 * @param path - `/orders/o3`, `/orders/o3/` or `/`.
 * @returns `['orders', 'o3']`, or `[]` for the root.
 */
export function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Decodes one segment, keeping it as it is when it is not valid percent-encoding.
 *
 * @param segment - A path segment.
 * @returns The decoded text.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Matches a path against one route.
 *
 * @param route - The route: literal segments and `:param` segments.
 * @param path - The path.
 * @returns The parameters, or null when the path doesn't fit.
 */
function matchOne(route: string, path: string): Record<string, string> | null {
  const routeSegments = segmentsOf(route);
  const pathSegments = segmentsOf(path);
  if (routeSegments.length !== pathSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const [index, routeSegment] of routeSegments.entries()) {
    const pathSegment = pathSegments[index] ?? '';
    if (routeSegment.startsWith(PARAM_PREFIX)) {
      params[routeSegment.slice(PARAM_PREFIX.length)] = decodeSegment(pathSegment);
    } else if (routeSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

/**
 * Says how specific a route is, so `/orders/new` wins over `/orders/:id` for `/orders/new` whatever their order.
 *
 * @param route - The route.
 * @returns One flag per segment, 1 for literal and 0 for a parameter; compared left to right, more wins.
 */
function specificityOf(route: string): number[] {
  return segmentsOf(route).map((segment) => (segment.startsWith(PARAM_PREFIX) ? 0 : 1));
}

/**
 * Orders two routes of the same length, the more specific first.
 *
 * @param a - One route.
 * @param b - The other.
 * @returns Negative when `a` is more specific.
 */
function bySpecificity(a: string, b: string): number {
  const left = specificityOf(a);
  const right = specificityOf(b);
  const differing = left.findIndex((flag, index) => flag !== right[index]);
  return differing === -1 ? 0 : (right[differing] ?? 0) - (left[differing] ?? 0);
}

/**
 * Finds the route a path is on.
 *
 * @param routes - The table's routes, as declared.
 * @param path - The module's current path.
 * @returns The most specific route that fits, with its parameters, or null when none does. Of two equally specific
 * routes, the one declared first wins.
 */
export function matchRoute(routes: readonly string[], path: string): RouteMatch | null {
  const fitting = routes.filter((route) => matchOne(route, path) !== null).toSorted(bySpecificity);
  const [route] = fitting;
  if (route === undefined) {
    return null;
  }
  return { route, params: matchOne(route, path) ?? {} };
}
