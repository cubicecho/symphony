import { Badge } from '@/components/ui/badge';

/** What the badge says, per thing: a concept is served or not; a draft or proposal only could be. */
const SERVABLE_LABELS = {
  concept: { yes: 'Served', no: 'Not served' },
  draft: { yes: 'Servable', no: 'Not servable' },
} as const;

interface ConceptServableBadgeProps {
  /** Whether the unified API serves the concept, or would once it is saved. */
  servable: boolean;
  /** A stored concept, or a draft or proposal that is not one yet. */
  kind?: keyof typeof SERVABLE_LABELS | undefined;
}

/** Whether a concept is served, or a draft could be, as a soft badge. */
export function ConceptServableBadge({ servable, kind = 'concept' }: ConceptServableBadgeProps) {
  const labels = SERVABLE_LABELS[kind];
  return servable ? (
    <Badge variant="positive-soft">{labels.yes}</Badge>
  ) : (
    <Badge variant="destructive-soft">{labels.no}</Badge>
  );
}
