import { createFileRoute, Link } from '@tanstack/react-router';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { ModuleEditor } from '@/modules/module-editor';
import { useModule } from '@/modules/use-modules';

export const Route = createFileRoute('/modules/$id')({ component: ModuleRoute });

/** One module's editor, once it has loaded. */
function ModuleRoute() {
  const { id } = Route.useParams();
  const query = useModule(id);
  const module = query.data;
  if (module === undefined || module === null) {
    return (
      <PageLayout
        title={query.isPending ? '' : 'Module'}
        loading={query.isPending}
        contentSlot={
          <LoadState
            query={query}
            what="this module"
            record={module}
            notFoundLabel="Module not found"
            level={2}
            description="It may have been deleted, or the link is old."
            actionSlot={<Button variant="outline" linkSlot={<Link to="/modules" />} content="Back to modules" />}
          />
        }
      />
    );
  }
  // A save hands back a new updatedAt, so the form starts again from what was saved.
  return <ModuleEditor key={`${module.id}:${module.updatedAt}`} module={module} />;
}
