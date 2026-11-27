import { createFileRoute } from '@tanstack/react-router';
import { ConceptsView } from '@/concepts/concepts-view';

export const Route = createFileRoute('/concepts/')({ component: ConceptsView });
