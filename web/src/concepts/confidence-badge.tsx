import type { ProposalConfidence } from '@/__generated__/graphql';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { CONFIDENCE_LABELS, labelOf } from './concept-proposals.ts';

/** Each confidence's colour: sure is fine, a guess wants a glance, a fallback wants a hand. */
const CONFIDENCE_VARIANTS: Record<ProposalConfidence, BadgeVariant> = {
  HIGH: 'positive-soft',
  MEDIUM: 'warning-soft',
  LOW: 'destructive-soft',
};

interface ConfidenceBadgeProps {
  confidence: ProposalConfidence;
}

/** How sure the proposer is of a decision, as a soft badge. */
export function ConfidenceBadge({ confidence }: ConfidenceBadgeProps) {
  return (
    <Badge variant={CONFIDENCE_VARIANTS[confidence] ?? 'secondary'}>
      {labelOf(CONFIDENCE_LABELS, confidence)} confidence
    </Badge>
  );
}
