import { createFileRoute } from '@tanstack/react-router';
import { moduleSearchOf, pathOfSplat } from '@/modules/module-url';
import { ItemFullPage } from '@/pages/item-full-page';

// `$slug_` keeps this route out of the page's own: it draws in place of the page, not inside it.
export const Route = createFileRoute('/pages/$slug_/items/$itemId/$')({
  component: ItemFullPageRoute,
  validateSearch: moduleSearchOf,
});

/**
 * One placed module across the whole page, at the module path the rest of the URL names. The search params are the
 * page's, carried along so its other modules keep their paths on the way back.
 */
function ItemFullPageRoute() {
  const { slug, itemId, _splat } = Route.useParams();
  const pageSearch = Route.useSearch();
  return (
    <ItemFullPage
      key={`${slug}:${itemId}`}
      slug={slug}
      itemId={itemId}
      path={pathOfSplat(_splat)}
      pageSearch={pageSearch}
    />
  );
}
