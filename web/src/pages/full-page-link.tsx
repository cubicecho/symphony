import { Link } from '@tanstack/react-router';
import { itemPathOf, type ModuleSearch, splatOf, withItemPath } from '@/modules/module-url';
import { ROOT_PATH } from '@/modules/route-match';

/**
 * The router link that opens a placed module full page, at the path it is on now. The page's other search params go
 * along, so its other modules are where they were when the reader comes back.
 *
 * @param slug - The page.
 * @param itemId - The item.
 * @param pageSearch - The page's search params now.
 * @returns A router link with no children, for a `linkSlot`.
 */
export function fullPageLinkOf(slug: string, itemId: string, pageSearch: ModuleSearch) {
  return (
    <Link
      to="/pages/$slug/items/$itemId/$"
      params={{ slug, itemId, _splat: splatOf(itemPathOf(pageSearch, itemId)) }}
      search={withItemPath(pageSearch, itemId, ROOT_PATH)}
    />
  );
}
