// The routing half of the `symphony` runtime: `Routes`, `RouteLink` and `useRoute`. runtime.ts re-exports them, and
// docs/module-contract.md ("Routes inside a module") documents them.
import { type AnchorHTMLAttributes, createContext, type MouseEvent, type ReactNode, type Ref, useContext } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { assertModulePath, useModuleRouter } from './module-router.ts';
import { matchRoute, ROOT_PATH, type RouteMatch } from './route-match.ts';

/** What one route draws. Called as the body of its own component, so it may use hooks. */
export type RouteView = () => ReactNode;

/** What `useRoute` hands back. */
export interface RouteState {
  /** The module's current path: `/orders/o3`. */
  path: string;
  /** The values of the matched route's `:param` segments: `{ id: 'o3' }` for `/orders/:id`. Empty outside `Routes`. */
  params: Record<string, string>;
  /** Goes to another path in the module: `navigate('/orders/o3')`. Back and forward follow it. */
  navigate: (path: string) => void;
}

interface RoutesProps {
  /** Each route's path, `:name` for a parameter segment, and what it draws: `{ '/': () => <List /> }`. */
  routes: Readonly<Record<string, RouteView>>;
  /** What a path no route matches draws. Left out, a line saying so with a link back to `/`. */
  fallback?: RouteView | undefined;
}

interface RouteLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The path in the module it goes to, from its root: `/orders/o3`. */
  to: string;
  ref?: Ref<HTMLAnchorElement> | undefined;
}

/** The route `Routes` matched, for `useRoute` below it. */
const RouteMatchContext = createContext<RouteMatch | null>(null);

/** The mouse button a plain click is made with. */
const PRIMARY_BUTTON = 0;

/** No parameters, outside `Routes`. */
const NO_PARAMS: Readonly<Record<string, string>> = {};

/**
 * Reads where the module is.
 *
 * @returns The path, the matched route's params, and `navigate`.
 */
export function useRoute(): RouteState {
  const router = useModuleRouter();
  const match = useContext(RouteMatchContext);
  return { path: router.path, params: match?.params ?? NO_PARAMS, navigate: router.navigate };
}

/**
 * Draws the route the module's path is on, or `fallback` when it is on none.
 *
 * @param props - The route table, and the fallback.
 * @returns The matched route's view.
 */
export function Routes({ routes, fallback = NotFound }: RoutesProps) {
  const { path } = useModuleRouter();
  const match = matchRoute(Object.keys(routes), path);
  const view = match === null ? undefined : routes[match.route];
  if (match === null || view === undefined) {
    return <RouteBody key={`fallback:${path}`} view={fallback} />;
  }
  return (
    <RouteMatchContext.Provider value={match}>
      <RouteBody key={path} view={view} />
    </RouteMatchContext.Provider>
  );
}

/**
 * Calls one route's view as its own component, keyed by path, so its hooks stay its own and each subpage
 * (`/orders/o1`, then `/orders/o2`) starts with fresh state.
 *
 * @param props - The view.
 * @param props.view - What the route draws.
 * @returns What it draws.
 */
function RouteBody({ view }: { view: RouteView }) {
  return view();
}

/**
 * What a path no route matches shows by default.
 *
 * @returns A line naming the path, with a link to the module's first view.
 */
function NotFound() {
  const { path } = useModuleRouter();
  return (
    <EmptyState
      compact
      title={`There is nothing at ${path} in this module.`}
      actionSlot={
        <Button size="sm" variant="outline" content="Back to the start" linkSlot={<RouteLink to={ROOT_PATH} />} />
      }
    />
  );
}

/**
 * Tells whether a click asks the browser for something else than following the link here: a new tab or window.
 *
 * @param event - The click.
 * @returns True for a modified or non-primary click.
 */
function isBrowserClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== PRIMARY_BUTTON || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * A link to a path in the module. A plain click goes there in place; a modified one opens its address, as any link.
 * It takes an anchor's props, so it fits a cubeui `linkSlot`: `<Button linkSlot={<RouteLink to="/" />} … />`.
 *
 * @param props - Where it goes, and the anchor's own props.
 * @returns An `<a>`.
 */
export function RouteLink({ to, onClick, target, ...anchor }: RouteLinkProps) {
  const router = useModuleRouter();
  assertModulePath(to);

  /**
   * Follows the link in place, unless the click or the caller asked otherwise.
   *
   * @param event - The click.
   */
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    const isLeftToBrowser =
      event.defaultPrevented || isBrowserClick(event) || (target !== undefined && target !== '_self');
    if (isLeftToBrowser) {
      return;
    }
    event.preventDefault();
    router.navigate(to);
  };

  return <a {...anchor} target={target} href={router.hrefOf(to)} onClick={follow} />;
}
