import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { GitBranch, Layers, Plus, Trash2 } from '@/components/ui/icons';
import { countLabel } from '@/core/format';
import { ProblemAlert } from '@/core/problem-alert';
import { messageOf } from '@/lib/error-message';
import { ConceptServableBadge } from './concept-servable-badge.tsx';
import { summarizeDefinition } from './concept-summary.ts';
import { RemoveConceptDialog } from './remove-concept-dialog.tsx';
import { UnifiedStatusCard } from './unified-status-card.tsx';
import { type Concept, useConcepts, useRemoveConcept } from './use-concepts.ts';

/** The concepts screen: the unified API's state, then every concept, whether it is served, and its problems. */
export function ConceptsView() {
  const query = useConcepts();
  const concepts = query.data ?? [];
  const [problem, setProblem] = useState<string | null>(null);
  const newButton = (
    <Button size="sm" variant="info" iconSlot={<Plus />} content="New concept" linkSlot={<Link to="/concepts/new" />} />
  );

  return (
    <PageLayout
      title="Concepts"
      description="Entities that live in several upstreams, read and written as one through the unified API."
      actionSlot={
        <>
          <Button
            size="sm"
            variant="outline"
            iconSlot={<GitBranch />}
            content="Wiring"
            linkSlot={<Link to="/wiring" />}
          />
          {newButton}
        </>
      }
      contentSlot={
        <>
          <UnifiedStatusCard />
          <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} />
          <LoadState
            query={query}
            what="your concepts"
            count={concepts.length}
            emptySlot={
              <EmptyState
                iconSlot={<Layers />}
                title="No concepts yet"
                description="A concept names the fields its members share and own, and the documents that read and write it in each upstream."
                actionSlot={newButton}
              />
            }
          />
          {concepts.length === 0 ? null : (
            <List
              label="Concepts"
              contentSlot={concepts.map((concept) => (
                <ConceptRow key={concept.id} concept={concept} onProblem={setProblem} />
              ))}
            />
          )}
        </>
      }
    />
  );
}

interface ConceptRowProps {
  concept: Concept;
  /** Told what went wrong when a remove fails. */
  onProblem: (problem: string) => void;
}

/** One concept: its name, its members, whether it is served and how many problems keep it from being. */
function ConceptRow({ concept, onProblem }: ConceptRowProps) {
  const removeConcept = useRemoveConcept();
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const { members, shared, owned } = summarizeDefinition(concept.definition);
  const memberNames = members.map((member) => member.upstream).join(', ');
  const fieldCount = countLabel(shared.length + owned.length, 'field', 'fields');

  /** Removes the concept, and says so when the server refuses. */
  const remove = (): void => {
    removeConcept.mutate(concept.id, {
      onError: (error) => onProblem(`Couldn't remove ${concept.name}. ${messageOf(error) ?? ''}`.trim()),
    });
  };

  return (
    <>
      <ListItem
        title={concept.name}
        description={memberNames === '' ? fieldCount : `${fieldCount} across ${memberNames}`}
        meta={
          <span className="flex items-center gap-2">
            <ConceptServableBadge servable={concept.servable} />
            {concept.problems.length === 0 ? null : (
              <span className="text-foreground/60 text-xs">
                {countLabel(concept.problems.length, 'problem', 'problems')}
              </span>
            )}
          </span>
        }
        linkSlot={<Link to="/concepts/$name" params={{ name: concept.name }} />}
        actionSlot={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${concept.name}`}
            iconSlot={<Trash2 />}
            loading={removeConcept.isPending}
            onClick={() => setIsConfirmingRemove(true)}
          />
        }
      />
      <RemoveConceptDialog
        name={concept.name}
        open={isConfirmingRemove}
        onOpenChange={setIsConfirmingRemove}
        onConfirm={remove}
      />
    </>
  );
}
