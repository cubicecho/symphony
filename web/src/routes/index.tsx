import { createFileRoute } from '@tanstack/react-router';
import { moduleSearchOf } from '@/modules/module-url';
import { PageView } from '@/pages/page-view';
import { HOME_SLUG } from '@/pages/use-pages';

export const Route = createFileRoute('/')({ component: HomeRoute, validateSearch: moduleSearchOf });

/** Home, which is always there. Its search params keep each placed module's path. */
function HomeRoute() {
  return <PageView slug={HOME_SLUG} />;
}
