// Where a module's own path lives while it runs: in its page's URL, in the full-page view's URL, or, in the editor's
// preview, in memory. The runtime's `Routes`, `RouteLink` and `useRoute` read it through `ModuleRouterContext`.
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { createContext, useContext, useMemo, useState } from 'react';
import { itemPathOf, withItemPath } from './module-url.ts';
import { ROOT_PATH } from './route-match.ts';

/** A module's path, and the way to change it. */
export interface ModuleRouter {
  /** The module's current path, `/` on its first view. */
  path: string;
  /** Goes to another path in the module, as a new history entry where there is a URL. */
  navigate: (path: string) => void;
  /** The address a link to a path in the module opens, for a new tab or a copied link. */
  hrefOf: (path: string) => string;
}

/** The router of the module being drawn. `ModuleCard` provides it around every module. */
export const ModuleRouterContext = createContext<ModuleRouter | null>(null);

/**
 * Checks a path a module asked to go to.
 *
 * @param path - The path.
 * @throws When it does not start with `/`: a module's paths are its own, from its root.
 */
export function assertModulePath(path: string): void {
  const isAbsolute = path.startsWith(ROOT_PATH);
  if (isAbsolute === false) {
    throw new Error(
      `"${path}" is not a module path. Start it with "/", as in "/orders/o3": paths are the module's own.`,
    );
  }
}

/**
 * Reads the router of the module being drawn.
 *
 * @returns The router `ModuleCard` provides.
 * @throws When called outside a module card.
 */
export function useModuleRouter(): ModuleRouter {
  const router = useContext(ModuleRouterContext);
  if (router === null) {
    throw new Error(
      'Routes, RouteLink and useRoute only work inside a module placed on a page or previewed in its editor.',
    );
  }
  return router;
}

/**
 * The router of a module card: on a page, the item's path is kept in the page URL under `m.<itemId>`; with no item
 * (the editor's preview) it is kept in memory, so the editor's URL is left alone.
 *
 * @param itemId - The page item the card draws, or undefined in the editor.
 * @returns The router.
 */
export function useCardRouter(itemId: string | undefined): ModuleRouter {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const navigate = useNavigate();
  const router = useRouter();
  const [memoryPath, setMemoryPath] = useState(ROOT_PATH);
  const path = itemId === undefined ? memoryPath : itemPathOf(search, itemId);

  return useMemo<ModuleRouter>(() => {
    if (itemId === undefined) {
      return {
        path,
        navigate: (next) => {
          assertModulePath(next);
          setMemoryPath(next);
        },
        hrefOf: (next) => `#${next}`,
      };
    }
    const searchFor = (next: string) => (previous: Record<string, unknown>) => withItemPath(previous, itemId, next);
    return {
      path,
      navigate: (next) => {
        assertModulePath(next);
        void navigate({ to: '.', search: searchFor(next) });
      },
      hrefOf: (next) => router.buildLocation({ to: '.', search: searchFor(next) }).href,
    };
  }, [itemId, path, navigate, router]);
}
