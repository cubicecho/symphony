import type { StatusLook } from '@/components/ui/status-badge';
import {
  CONFIDENCE_LABELS,
  type ConceptProposalStatus,
  type ProposalConfidence,
  STATUS_LABELS,
} from './concept-proposals.ts';

/** Each proposal status as a badge: waiting on a person, saved, or turned down. */
export const PROPOSAL_STATUSES: Record<ConceptProposalStatus, StatusLook> = {
  PENDING: { label: STATUS_LABELS.PENDING, variant: 'info-soft' },
  ACCEPTED: { label: STATUS_LABELS.ACCEPTED, variant: 'positive-soft' },
  REJECTED: { label: STATUS_LABELS.REJECTED, variant: 'secondary' },
};

/** Each confidence as a badge: sure is fine, a guess wants a glance, a fallback wants a hand. */
export const CONFIDENCE_STATUSES: Record<ProposalConfidence, StatusLook> = {
  HIGH: { label: `${CONFIDENCE_LABELS.HIGH} confidence`, variant: 'positive-soft' },
  MEDIUM: { label: `${CONFIDENCE_LABELS.MEDIUM} confidence`, variant: 'warning-soft' },
  LOW: { label: `${CONFIDENCE_LABELS.LOW} confidence`, variant: 'destructive-soft' },
};
