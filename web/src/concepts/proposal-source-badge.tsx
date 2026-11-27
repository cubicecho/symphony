import type { ConceptProposalSource } from '@/__generated__/graphql';
import { Badge } from '@/components/ui/badge';
import { labelOf, SOURCE_LABELS } from './concept-proposals.ts';

interface ProposalSourceBadgeProps {
  source: ConceptProposalSource;
}

/** Who drafted a proposal: the proposer, an agent over MCP, or a person. */
export function ProposalSourceBadge({ source }: ProposalSourceBadgeProps) {
  return <Badge variant="outline">{labelOf(SOURCE_LABELS, source)}</Badge>;
}
