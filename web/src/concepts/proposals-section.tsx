import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { Section } from '@/components/section';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatCount, formatDateTime } from '@/lib/format';
import { PROPOSAL_FILTERS, type ProposalFilter, STATUS_LABELS } from './concept-proposals.ts';
import { ConceptServableBadge } from './concept-servable-badge.tsx';
import { ProposalSourceBadge } from './proposal-source-badge.tsx';
import { PROPOSAL_STATUSES } from './proposal-statuses.ts';
import { type ConceptProposal, useConceptProposals } from './use-concept-proposals.ts';

/** What the empty list says, per filter. */
const EMPTY_TITLES: Record<ProposalFilter, string> = {
  PENDING: 'Nothing waiting for review. Propose concepts from the upstreams, or have an agent submit one.',
  ACCEPTED: 'No accepted proposals yet.',
  REJECTED: 'No rejected proposals.',
  ALL: 'No proposals yet. Propose concepts from the upstreams, or have an agent submit one.',
};

/**
 * The stored proposals, pending ones by default, with a filter by status. Each row opens the proposal's review
 * screen.
 */
export function ProposalsSection() {
  const [filter, setFilter] = useState<ProposalFilter>('PENDING');
  const query = useConceptProposals(filter);
  const proposals = query.data ?? [];

  return (
    <Section
      level={2}
      title="Proposals"
      description="Concepts drafted from the upstreams, by an agent or by a person, waiting to be accepted or rejected."
      actionSlot={
        <SegmentedGroup aria-label="Show proposals" value={filter} onValueChange={setFilter}>
          {PROPOSAL_FILTERS.map((one) => (
            <SegmentedButton key={one} value={one}>
              {STATUS_LABELS[one]}
            </SegmentedButton>
          ))}
        </SegmentedGroup>
      }
      contentSlot={
        <>
          <LoadState
            query={query}
            what="the proposals"
            count={proposals.length}
            emptySlot={<EmptyState compact title={EMPTY_TITLES[filter]} />}
          />
          {proposals.length === 0 ? null : (
            <List
              label="Proposals"
              contentSlot={proposals.map((proposal) => (
                <ProposalRow key={proposal.id} proposal={proposal} showStatus={filter === 'ALL'} />
              ))}
            />
          )}
        </>
      }
    />
  );
}

interface ProposalRowProps {
  proposal: ConceptProposal;
  /** Wear the status, when the list mixes them. */
  showStatus: boolean;
}

/**
 * The line under a proposal's name: what its submitter said, or why it was rejected, and when.
 *
 * @param proposal - The proposal.
 * @returns "Drafted from shop and crm · updated 25 Nov 2026, 18:27".
 */
function proposalLine(proposal: ConceptProposal): string {
  const said = proposal.status === 'REJECTED' && proposal.reason !== null ? proposal.reason : proposal.note;
  const when =
    proposal.updatedAt === proposal.createdAt
      ? `proposed ${formatDateTime(proposal.createdAt)}`
      : `proposed ${formatDateTime(proposal.createdAt)}, revised ${formatDateTime(proposal.updatedAt)}`;
  return said === null || said === '' ? when : `${said} · ${when}`;
}

/** One proposal: its name, who drafted it, whether it would be served, and how many problems it has. */
function ProposalRow({ proposal, showStatus }: ProposalRowProps) {
  return (
    <ListItem
      title={proposal.name === '' ? 'Unnamed proposal' : proposal.name}
      description={proposalLine(proposal)}
      meta={
        <span className="flex flex-wrap items-center gap-2">
          {showStatus ? <StatusBadge status={proposal.status} statuses={PROPOSAL_STATUSES} /> : null}
          <ProposalSourceBadge source={proposal.source} />
          <ConceptServableBadge servable={proposal.servable} kind="draft" />
          {proposal.problems.length === 0 ? null : (
            <span className="text-foreground/60 text-xs">{formatCount(proposal.problems.length, 'problem')}</span>
          )}
        </span>
      }
      linkSlot={<Link to="/concepts/proposals/$id" params={{ id: proposal.id }} />}
    />
  );
}
