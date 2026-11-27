import { createFileRoute } from '@tanstack/react-router';
import { ConceptEditor } from '@/concepts/concept-editor';

export const Route = createFileRoute('/concepts/new')({ component: NewConceptRoute });

/** A new concept, prefilled with a definition that shows every part. */
function NewConceptRoute() {
  return <ConceptEditor />;
}
