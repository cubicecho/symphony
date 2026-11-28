import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { PageLayout } from '@/components/page-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Trash2 } from '@/components/ui/icons';
import { ProblemAlert } from '@/core/problem-alert';
import { messageOf } from '@/lib/error-message';
import { formatCount } from '@/lib/format';
import { ConceptServableBadge } from './concept-servable-badge.tsx';
import { summarizeDefinition } from './concept-summary.ts';
import { DefinitionEditor } from './definition-editor.tsx';
import { RemoveConceptDialog } from './remove-concept-dialog.tsx';
import { type Concept, useRemoveConcept, useSaveConcept } from './use-concepts.ts';

/** What a new concept starts from: every part a definition has, with names to replace. */
const STARTER_DEFINITION = {
  name: 'Thing',
  fields: [
    { name: 'title', mode: 'shared' },
    { name: 'notes', mode: 'owned', owner: 'first-upstream' },
  ],
  members: [
    {
      upstream: 'first-upstream',
      documents: {
        fetch: 'query Fetch($id: ID!) { thing(id: $id) { id title notes } }',
        create:
          'mutation Create($id: ID!, $title: String!, $notes: String) { createThing(id: $id, title: $title, notes: $notes) { id } }',
        update:
          'mutation Update($id: ID!, $title: String, $notes: String) { updateThing(id: $id, title: $title, notes: $notes) { id } }',
        delete: 'mutation Delete($id: ID!) { deleteThing(id: $id) }',
      },
    },
  ],
};

interface ConceptEditorProps {
  /** The concept as last saved. Left out, the editor creates one. */
  concept?: Concept | undefined;
}

/**
 * The concept editor: the definition as JSON, Save, the problems the server located, and a summary of what the
 * definition says beside it.
 */
export function ConceptEditor({ concept }: ConceptEditorProps) {
  const navigate = useNavigate();
  const saveConcept = useSaveConcept();
  const removeConcept = useRemoveConcept();
  const [problem, setProblem] = useState<string | null>(null);
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const isEdit = concept !== undefined;
  const memberCount = summarizeDefinition(concept?.definition).members.length;

  /**
   * Saves the definition and opens the concept it saved; a refusal is thrown for the editor to place.
   *
   * @param definition - The parsed definition.
   */
  const save = async (definition: unknown): Promise<void> => {
    const saved = await saveConcept.mutateAsync(definition);
    void navigate({ to: '/concepts/$name', params: { name: saved.name }, replace: true });
  };

  /** Removes the concept and goes back to the list, or says why not. */
  const remove = (): void => {
    if (concept === undefined) {
      return;
    }
    removeConcept.mutate(concept.id, {
      onSuccess: () => void navigate({ to: '/concepts' }),
      onError: (error) => setProblem(`Couldn't remove ${concept.name}. ${messageOf(error) ?? ''}`.trim()),
    });
  };

  return (
    <>
      <PageLayout
        title={concept?.name ?? 'New concept'}
        description={concept === undefined ? undefined : `${formatCount(memberCount, 'member')}.`}
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
          concept === undefined ? null : (
            <>
              <ConceptServableBadge servable={concept.servable} />
              <Button
                size="sm"
                variant="outline"
                iconSlot={<Trash2 />}
                content="Remove"
                onClick={() => setIsConfirmingRemove(true)}
              />
            </>
          )
        }
        contentSlot={
          <>
            <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} />
            <DefinitionEditor
              definition={concept?.definition ?? STARTER_DEFINITION}
              problems={concept?.problems ?? []}
              onSave={save}
              isEdit={isEdit}
              createLabel="Save concept"
              noticeSlot={(summary) => {
                const isRenamed = isEdit && summary.name !== null && summary.name !== concept.name;
                return isRenamed ? (
                  <Alert
                    variant="info"
                    title="Saved under a new name"
                    description={`Saving adds ${summary.name} as a concept of its own; ${concept.name} stays until you remove it.`}
                  />
                ) : null;
              }}
            />
          </>
        }
      />
      {concept === undefined ? null : (
        <RemoveConceptDialog
          name={concept.name}
          open={isConfirmingRemove}
          onOpenChange={setIsConfirmingRemove}
          onConfirm={remove}
        />
      )}
    </>
  );
}
