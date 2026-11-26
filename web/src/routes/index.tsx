import { createFileRoute } from '@tanstack/react-router';
import { PageView } from '@/pages/page-view';
import { HOME_SLUG } from '@/pages/use-pages';

export const Route = createFileRoute('/')({ component: HomeRoute });

/** Home, which is always there. */
function HomeRoute() {
  return <PageView slug={HOME_SLUG} />;
}
