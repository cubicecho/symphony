import { createFileRoute, Link } from '@tanstack/react-router';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { ConceptEditor } from '@/concepts/concept-editor';
import { useConcept } from '@/concepts/use-concepts';

export const Route = createFileRoute('/concepts/$name')({ component: ConceptRoute });

/** One concept's editor, once it has loaded. */
function ConceptRoute() {
  const { name } = Route.useParams();
  const query = useConcept(name);
  const concept = query.data;
  if (concept === undefined || concept === null) {
    return (
      <PageLayout
        title={query.isPending ? '' : 'Concept'}
        loading={query.isPending}
        contentSlot={
          <LoadState
            query={query}
            what="this concept"
            record={concept}
            notFoundLabel="Concept not found"
            level={2}
            description="It may have been removed, or the link is old."
            actionSlot={<Button variant="outline" linkSlot={<Link to="/concepts" />} content="Back to concepts" />}
          />
        }
      />
    );
  }
  // A save hands back a new updatedAt, so the form starts again from what was saved.
  return <ConceptEditor key={`${concept.id}:${concept.updatedAt}`} concept={concept} />;
}
