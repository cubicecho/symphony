// Where a placed module's path lives in the app's URLs: in its page's search params, one key per item
// (`/pages/home?m.4f2a=/orders/o3`), and in the full-page view's path (`/pages/home/items/4f2a/orders/o3`).
import { ROOT_PATH } from './route-match.ts';

/** What starts the search key that holds one item's path. */
export const ITEM_SEARCH_PREFIX = 'm.';

/** One item's search key: `m.<itemId>`. */
export type ItemSearchKey = `${typeof ITEM_SEARCH_PREFIX}${string}`;

/**
 * A page's search params: each placed module's path under its `m.<itemId>` key, a string, and whatever else the URL
 * carries. `itemPathOf` reads a path out of it.
 */
export type ModuleSearch = Record<string, unknown>;

/**
 * The key an item's path is kept under.
 *
 * @param itemId - The page item.
 * @returns `m.<itemId>`.
 */
export function itemSearchKey(itemId: string): ItemSearchKey {
  return `${ITEM_SEARCH_PREFIX}${itemId}`;
}

/**
 * Reads a page's search params for its route's `validateSearch`.
 *
 * @param search - The parsed search params.
 * @returns The same params, less any `m.*` key whose value is not a string: other params are left as they are.
 */
export function moduleSearchOf(search: Record<string, unknown>): ModuleSearch {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) => key.startsWith(ITEM_SEARCH_PREFIX) === false || typeof value === 'string',
    ),
  );
}

/**
 * Reads one item's path from a page's search params.
 *
 * @param search - The search params, as any route has them.
 * @param itemId - The page item.
 * @returns Its path, or the root when the URL holds none.
 */
export function itemPathOf(search: Record<string, unknown>, itemId: string): string {
  const path = search[itemSearchKey(itemId)];
  return typeof path === 'string' ? path : ROOT_PATH;
}

/**
 * Sets one item's path in a page's search params.
 *
 * @param search - The search params now.
 * @param itemId - The page item.
 * @param path - Its new path. The root takes the key out, so a module on its first view leaves the URL clean.
 * @returns The new search params.
 */
export function withItemPath(search: Record<string, unknown>, itemId: string, path: string): ModuleSearch {
  const key = itemSearchKey(itemId);
  const { [key]: _previous, ...rest } = search;
  return path === ROOT_PATH ? rest : { ...rest, [key]: path };
}

/**
 * The splat the full-page view's URL carries for a module path.
 *
 * @param path - `/orders/o3`.
 * @returns `orders/o3`: the URL's last segments, after the item id.
 */
export function splatOf(path: string): string {
  return path.slice(ROOT_PATH.length);
}

/**
 * The module path a full-page view's splat stands for.
 *
 * @param splat - `orders/o3`, or undefined or empty for the module's root.
 * @returns `/orders/o3`.
 */
export function pathOfSplat(splat: string | undefined): string {
  return `${ROOT_PATH}${splat ?? ''}`;
}
