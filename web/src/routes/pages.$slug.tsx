import { createFileRoute } from '@tanstack/react-router';
import { moduleSearchOf } from '@/modules/module-url';
import { PageView } from '@/pages/page-view';

export const Route = createFileRoute('/pages/$slug')({ component: PageRoute, validateSearch: moduleSearchOf });

/** Any page, by its slug. Its search params keep each placed module's path. */
function PageRoute() {
  const { slug } = Route.useParams();
  return <PageView key={slug} slug={slug} />;
}
