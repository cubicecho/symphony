import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageLayout } from '@/components/page-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Check, X } from '@/components/ui/icons';
import { StatusBadge } from '@/components/ui/status-badge';
import { messageOf } from '@/lib/error-message';
import { formatCount, formatDateTime } from '@/lib/format';
import { labelOf, SOURCE_LABELS } from './concept-proposals.ts';
import { ConceptServableBadge } from './concept-servable-badge.tsx';
import { type ConceptProblem, conceptProblemsOf } from './concept-summary.ts';
import { DefinitionEditor } from './definition-editor.tsx';
import { ProposalSourceBadge } from './proposal-source-badge.tsx';
import { PROPOSAL_STATUSES } from './proposal-statuses.ts';
import { RejectProposalDialog } from './reject-proposal-dialog.tsx';
import { type ConceptProposal, useAcceptConceptProposal, useSubmitConceptProposal } from './use-concept-proposals.ts';

/** How a pending proposal's stored problems are introduced. */
const STORED_PROBLEMS = {
  title: 'Problems now',
  description: 'Found when it was last submitted or accepted. Accepting checks it again.',
};

/** How the problems of a refused accept are introduced. */
const REFUSED_PROBLEMS = {
  title: 'Why it was not accepted',
  description: 'From the accept just refused. Lines count within the document named.',
};

interface ProposalReviewProps {
  proposal: ConceptProposal;
}

/**
 * Reviewing one proposal: its definition beside a summary of what it says, saved as revisions while it is pending,
 * then accepted as a concept or rejected. Once it is decided it is read-only, and an accepted one links to its
 * concept.
 */
export function ProposalReview({ proposal }: ProposalReviewProps) {
  const submit = useSubmitConceptProposal();
  const accept = useAcceptConceptProposal();
  const [refusedProblems, setRefusedProblems] = useState<ConceptProblem[] | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [isRejecting, setIsRejecting] = useState(false);
  const isPending = proposal.status === 'PENDING';
  const name = proposal.name === '' ? 'Unnamed proposal' : proposal.name;

  /**
   * Stores the edited definition as a revision of this proposal; it is stored whatever problems it has.
   *
   * @param definition - The parsed definition.
   */
  const saveRevision = async (definition: unknown): Promise<void> => {
    // A revision replaces the note and source too, so both are sent as they are.
    await submit.mutateAsync({
      definition,
      id: proposal.id,
      source: proposal.source,
      note: proposal.note ?? undefined,
    });
    setRefusedProblems(null);
    setAcceptError(null);
  };

  /** Saves the proposal as a concept, or places the problems the refusal located. */
  const acceptProposal = (): void => {
    setAcceptError(null);
    accept.mutate(proposal.id, {
      onSuccess: () => setRefusedProblems(null),
      onError: (error) => {
        const located = conceptProblemsOf(error);
        setRefusedProblems(located);
        setAcceptError(
          located === null
            ? (messageOf(error) ?? 'It was not accepted. Try again.')
            : `It has ${formatCount(located.length, 'problem')}, listed below and in the summary.`,
        );
      },
    });
  };

  const when =
    proposal.updatedAt === proposal.createdAt
      ? `Proposed ${formatDateTime(proposal.createdAt)}`
      : `Proposed ${formatDateTime(proposal.createdAt)}, revised ${formatDateTime(proposal.updatedAt)}`;

  return (
    <>
      <PageLayout
        title={name}
        description={`${labelOf(SOURCE_LABELS, proposal.source)} proposal. ${when}.`}
        backSlot={
          <Button
            variant="ghost"
            size="sm"
            iconSlot={<ArrowLeft />}
            content="Concepts"
            linkSlot={<Link to="/concepts" />}
          />
        }
        actionSlot={
          <>
            <StatusBadge status={proposal.status} statuses={PROPOSAL_STATUSES} />
            <ProposalSourceBadge source={proposal.source} />
            {isPending ? <ConceptServableBadge servable={proposal.servable} kind="draft" /> : null}
            {isPending ? (
              <Button
                size="sm"
                variant="outline"
                iconSlot={<X />}
                content="Reject"
                onClick={() => setIsRejecting(true)}
              />
            ) : null}
            {proposal.concept === null ? null : (
              <Button
                size="sm"
                variant="outline"
                content="Open concept"
                linkSlot={<Link to="/concepts/$name" params={{ name: proposal.concept.name }} />}
              />
            )}
          </>
        }
        contentSlot={
          <>
            <DecisionAlert proposal={proposal} />
            {proposal.note === null || proposal.note === '' ? null : (
              <Alert variant="default" title="Note from the submitter" description={proposal.note} />
            )}
            {acceptError === null ? null : (
              <Alert variant="destructive" title="Not accepted" description={acceptError} />
            )}
            <DefinitionEditor
              // A revision hands back a new updatedAt, so the form starts again from what was stored.
              key={`${proposal.id}:${proposal.updatedAt}`}
              definition={proposal.definition}
              problems={refusedProblems ?? proposal.problems}
              problemsIntro={refusedProblems === null ? STORED_PROBLEMS : REFUSED_PROBLEMS}
              onSave={isPending ? saveRevision : undefined}
              description="JSON, as submitted. Saving stores a revision of this proposal, problems and all; accepting saves it as a concept, which recomposes the unified API."
              isEdit
              createLabel="Save revision"
              editLabel="Save revision"
              footerActionsSlot={({ isChanged }) => (
                <Button
                  variant="info"
                  iconSlot={<Check />}
                  content="Accept"
                  hint={isChanged ? 'Save the revision first: accepting saves what is stored.' : undefined}
                  disabled={isChanged}
                  loading={accept.isPending}
                  loadingLabel="Accepting…"
                  onClick={acceptProposal}
                />
              )}
            />
          </>
        }
      />
      {isPending ? (
        <RejectProposalDialog id={proposal.id} name={name} open={isRejecting} onOpenChange={setIsRejecting} />
      ) : null}
    </>
  );
}

/** What was decided about a proposal that is no longer pending. */
function DecisionAlert({ proposal }: { proposal: ConceptProposal }) {
  if (proposal.status === 'ACCEPTED') {
    return (
      <Alert
        variant="info"
        title="Accepted"
        description={
          proposal.concept === null
            ? 'It was saved as a concept, which has since been removed.'
            : `Saved as the concept ${proposal.concept.name}. Changes are made there now.`
        }
      />
    );
  }
  if (proposal.status === 'REJECTED') {
    return (
      <Alert
        variant="default"
        title="Rejected"
        description={proposal.reason === null || proposal.reason === '' ? 'No reason was given.' : proposal.reason}
      />
    );
  }
  return null;
}
