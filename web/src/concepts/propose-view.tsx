import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { CardLayout } from '@/components/card-layout';
import { CollapsibleRow } from '@/components/collapsible-row';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Pencil, Sparkles, X } from '@/components/ui/icons';
import { ToggleChip } from '@/components/ui/toggle-chip';
import { countLabel } from '@/core/format';
import { ProblemAlert } from '@/core/problem-alert';
import { messageOf } from '@/lib/error-message';
import { useUpstreams } from '@/upstreams/use-upstreams';
import { ConceptProblemList } from './concept-problem-list.tsx';
import {
  draftSourceOf,
  groupReasons,
  toggleUpstream,
  unsureReasonCount,
  upstreamChoiceOf,
} from './concept-proposals.ts';
import { ConceptServableBadge } from './concept-servable-badge.tsx';
import { summarizeDefinition } from './concept-summary.ts';
import { ConceptSummaryContent } from './concept-summary-card.tsx';
import { ConfidenceBadge } from './confidence-badge.tsx';
import { DefinitionEditor } from './definition-editor.tsx';
import {
  type ConceptDraft,
  type NotReadyConcept,
  useConceptDrafts,
  useSubmitConceptProposal,
} from './use-concept-proposals.ts';

/** The draft open in the editor, and how many times one was opened, so reopening starts it again. */
interface EditingDraft {
  draft: ConceptDraft;
  opened: number;
}

/**
 * The propose screen: pick the upstreams, draft concepts from their schemas, review each draft's fields, documents
 * and the reasons behind them, then save it as a proposal as it is, or edit it first.
 */
export function ProposeView() {
  const navigate = useNavigate();
  const upstreams = useUpstreams();
  const choice = upstreamChoiceOf(upstreams.data ?? []);
  // Null until the reader changes it: every upstream with a schema.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const picked = chosen ?? choice.ready;
  const [requested, setRequested] = useState<string[] | null>(null);
  const drafts = useConceptDrafts(requested);
  const submit = useSubmitConceptProposal();
  const [savedIds, setSavedIds] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingDraft | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing !== null) {
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [editing]);

  /**
   * Saves a draft as a pending proposal, as the proposer drafted it.
   *
   * @param draft - The draft.
   */
  const saveDraft = (draft: ConceptDraft): void => {
    submit.mutate(
      { definition: draft.definition, source: 'GENERATED' },
      {
        onSuccess: (proposal) => setSavedIds((saved) => ({ ...saved, [draft.name]: proposal.id })),
        onError: (error) => setProblem(`Couldn't save ${draft.name}. ${messageOf(error) ?? ''}`.trim()),
      },
    );
  };

  /**
   * Saves the edited draft as a proposal and opens it for review.
   *
   * @param draft - The draft the editor started from.
   * @param definition - The definition as edited.
   */
  const saveEdited = async (draft: ConceptDraft, definition: unknown): Promise<void> => {
    const proposal = await submit.mutateAsync({ definition, source: draftSourceOf(draft.definition, definition) });
    void navigate({ to: '/concepts/proposals/$id', params: { id: proposal.id } });
  };

  const upstreamCard = (
    <CardLayout
      title="Upstreams"
      description="Draft from the schemas of these upstreams. Types with the same name, or the same name once a prefix or suffix is removed, are drafted as one concept."
      contentSlot={
        <div className="grid gap-3">
          <LoadState
            query={upstreams}
            what="the upstreams"
            count={choice.ready.length}
            emptySlot={
              <EmptyState
                compact
                title="No upstream has a schema to draft from yet."
                actionSlot={
                  <Button size="xs" variant="outline" content="Upstreams" linkSlot={<Link to="/upstreams" />} />
                }
              />
            }
          />
          {choice.ready.length === 0 ? null : (
            // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, named as one group.
            <div role="group" aria-label="Upstreams to draft from" className="flex flex-wrap gap-2">
              {choice.ready.map((name) => (
                <ToggleChip
                  key={name}
                  size="sm"
                  selected={picked.includes(name)}
                  onClick={() => setChosen(toggleUpstream(picked, name, choice.ready))}
                >
                  {name}
                </ToggleChip>
              ))}
            </div>
          )}
          {choice.unfetched.length === 0 ? null : (
            <p className="text-foreground/60 text-sm">
              Left out until their schema is fetched: {choice.unfetched.join(', ')}.
            </p>
          )}
        </div>
      }
      footerActionsSlot={
        <Button
          variant="info"
          iconSlot={<Sparkles />}
          content={requested === null ? 'Draft concepts' : 'Draft again'}
          disabled={picked.length === 0}
          loading={drafts.isFetching}
          loadingLabel="Drafting…"
          onClick={() => {
            const isSame = requested !== null && requested.join('\n') === picked.join('\n');
            if (isSame) {
              void drafts.refetch();
            } else {
              setRequested(picked);
            }
          }}
        />
      }
    />
  );

  const result = drafts.data;
  return (
    <PageLayout
      title="Propose concepts"
      description="Drafts are not stored until you save one as a proposal. Nothing is served until a proposal is accepted."
      backSlot={
        <Button
          variant="ghost"
          size="sm"
          iconSlot={<ArrowLeft />}
          content="Concepts"
          linkSlot={<Link to="/concepts" />}
        />
      }
      contentSlot={
        <>
          <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} />
          {upstreamCard}
          {requested === null ? null : (
            <LoadState
              query={drafts}
              what="the drafts"
              count={(result?.drafts.length ?? 0) + (result?.notReady.length ?? 0)}
              emptySlot={
                <EmptyState
                  iconSlot={<Sparkles />}
                  title="Nothing to propose"
                  description="No type in these upstreams looks like one shared with another. Pick more upstreams, or write a concept by hand."
                />
              }
            />
          )}
          {result === undefined || result.drafts.length === 0 ? null : (
            <Section
              level={2}
              title="Drafts"
              description="Open one to see its fields, documents and the reasons behind each, with how sure the proposer is."
              contentSlot={
                <List
                  label="Drafts"
                  contentSlot={result.drafts.map((draft) => (
                    <DraftRow
                      key={draft.name}
                      draft={draft}
                      savedId={savedIds[draft.name]}
                      isSaving={submit.isPending && submit.variables?.definition === draft.definition}
                      onSave={() => saveDraft(draft)}
                      onEdit={() => setEditing({ draft, opened: (editing?.opened ?? 0) + 1 })}
                    />
                  ))}
                />
              }
            />
          )}
          {result === undefined || result.notReady.length === 0 ? null : <NotReadySection concepts={result.notReady} />}
          {editing === null ? null : (
            <div ref={editorRef} className="scroll-mt-4">
              <Section
                level={2}
                title={`Edit ${editing.draft.name}`}
                description="Saving stores it as a pending proposal, problems and all, and opens it for review."
                actionSlot={
                  <Button size="sm" variant="ghost" iconSlot={<X />} content="Close" onClick={() => setEditing(null)} />
                }
                contentSlot={
                  <DefinitionEditor
                    key={`${editing.draft.name}:${editing.opened}`}
                    definition={editing.draft.definition}
                    problems={editing.draft.problems}
                    problemsIntro={{
                      title: 'Problems in the draft',
                      description: 'Found when it was drafted. Saving checks it again.',
                    }}
                    onSave={(definition) => saveEdited(editing.draft, definition)}
                    isEdit={false}
                    createLabel="Save as proposal"
                  />
                }
              />
            </div>
          )}
        </>
      }
    />
  );
}

interface DraftRowProps {
  draft: ConceptDraft;
  /** The proposal it was saved as, once it is. */
  savedId: string | undefined;
  isSaving: boolean;
  onSave: () => void;
  onEdit: () => void;
}

/** One draft: closed, its name and counts; open, the reasons behind it, its problems and what it says. */
function DraftRow({ draft, savedId, isSaving, onSave, onEdit }: DraftRowProps) {
  const [isOpen, setIsOpen] = useState(false);
  const summary = summarizeDefinition(draft.definition);
  const unsure = unsureReasonCount(draft.reasons);
  const facts = [
    countLabel(summary.shared.length + summary.owned.length, 'field', 'fields'),
    `${countLabel(summary.members.length, 'member', 'members')}: ${summary.members.map((member) => member.upstream).join(', ')}`,
    unsure === 0 ? null : `${unsure} to check`,
    draft.problems.length === 0 ? null : countLabel(draft.problems.length, 'problem', 'problems'),
  ].filter((fact) => fact !== null);

  return (
    <CollapsibleRow
      open={isOpen}
      onOpenChange={setIsOpen}
      title={draft.name}
      badgesSlot={<ConceptServableBadge servable={draft.servable} kind="draft" />}
      meta={<span className="text-foreground/60 text-xs">{facts.join(' · ')}</span>}
      actionSlot={
        <>
          <Button size="sm" variant="outline" iconSlot={<Pencil />} content="Edit" onClick={onEdit} />
          {savedId === undefined ? (
            <Button size="sm" variant="outline" content="Save as proposal" loading={isSaving} onClick={onSave} />
          ) : (
            <Button
              size="sm"
              variant="outline"
              content="Open proposal"
              linkSlot={<Link to="/concepts/proposals/$id" params={{ id: savedId }} />}
            />
          )}
        </>
      }
      contentSlot={
        <div className="grid gap-6 pt-2">
          <ReasonsSection draft={draft} />
          {draft.problems.length === 0 ? null : (
            <Section
              level={3}
              title="Problems"
              description="What the concept check found in the draft as it is. Edit it to fix them, or save it and fix them in review."
              contentSlot={<ConceptProblemList problems={draft.problems} label={`Problems in ${draft.name}`} />}
            />
          )}
          <Section
            level={3}
            title="What it says"
            contentSlot={<ConceptSummaryContent summary={summary} problems={draft.problems} />}
          />
        </div>
      }
    />
  );
}

/** Why the proposer drafted what it did, grouped by the part of the concept each decision is about. */
function ReasonsSection({ draft }: { draft: ConceptDraft }) {
  const groups = groupReasons(draft.reasons);
  return (
    <Section
      level={3}
      title="Why"
      description="Each decision the proposer made. A medium one is a guess worth a glance; a low one probably needs writing by hand."
      contentSlot={
        groups.length === 0 ? (
          <EmptyState compact title="The proposer gave no reasons." />
        ) : (
          <List
            label={`Reasons for ${draft.name}`}
            contentSlot={groups.map((group) => (
              <ListItem
                key={group.about}
                title={group.label}
                description={
                  <ul className="grid gap-1 pt-1">
                    {group.reasons.map((reason) => (
                      <li key={reason.reason} className="flex flex-wrap items-start gap-2 text-foreground/80 text-sm">
                        <ConfidenceBadge confidence={reason.confidence} />
                        <span className="min-w-0 flex-1">{reason.reason}</span>
                      </li>
                    ))}
                  </ul>
                }
              />
            ))}
          />
        )
      }
    />
  );
}

/** Candidates that can't be drafted yet, each type with what it lacks. */
function NotReadySection({ concepts }: { concepts: readonly NotReadyConcept[] }) {
  return (
    <Section
      level={2}
      title="Not ready"
      description="Types that look shared but have fewer than two members ready. A member needs an id: ID! field and a lookup by id."
      contentSlot={
        <List
          label="Not ready"
          contentSlot={concepts.map((concept) => (
            <ListItem
              key={concept.name}
              title={concept.name}
              description={
                <ul className="grid gap-1 pt-1">
                  {concept.types.map((type) => (
                    <li key={`${type.upstream}.${type.type}`} className="text-foreground/80 text-sm">
                      <span className="font-mono">
                        {type.upstream}.{type.type}
                      </span>
                      : {type.reason}
                    </li>
                  ))}
                </ul>
              }
            />
          ))}
        />
      }
    />
  );
}
