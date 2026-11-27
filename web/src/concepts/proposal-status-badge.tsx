import type { ConceptProposalStatus } from '@/__generated__/graphql';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { labelOf, STATUS_LABELS } from './concept-proposals.ts';

/** Each status's colour: waiting on a person, saved, or turned down. */
const STATUS_VARIANTS: Record<ConceptProposalStatus, BadgeVariant> = {
  PENDING: 'info-soft',
  ACCEPTED: 'positive-soft',
  REJECTED: 'secondary',
};

interface ProposalStatusBadgeProps {
  status: ConceptProposalStatus;
}

/** Where a proposal stands, as a soft badge. */
export function ProposalStatusBadge({ status }: ProposalStatusBadgeProps) {
  return <Badge variant={STATUS_VARIANTS[status] ?? 'secondary'}>{labelOf(STATUS_LABELS, status)}</Badge>;
}
