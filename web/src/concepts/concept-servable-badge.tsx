import { Badge } from '@/components/ui/badge';

interface ConceptServableBadgeProps {
  /** Whether the unified API serves the concept. */
  servable: boolean;
}

/** Whether a concept is served, as a soft badge. */
export function ConceptServableBadge({ servable }: ConceptServableBadgeProps) {
  return servable ? (
    <Badge variant="positive-soft">Served</Badge>
  ) : (
    <Badge variant="destructive-soft">Not served</Badge>
  );
}
