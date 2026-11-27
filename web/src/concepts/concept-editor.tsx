import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { TextareaField, useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Trash2 } from '@/components/ui/icons';
import { countLabel } from '@/core/format';
import { onFormSubmit } from '@/core/forms';
import { ProblemAlert } from '@/core/problem-alert';
import { messageOf } from '@/lib/error-message';
import { ConceptProblemList } from './concept-problem-list.tsx';
import { ConceptServableBadge } from './concept-servable-badge.tsx';
import {
  type ConceptProblem,
  conceptProblemsOf,
  formatDefinition,
  parseDefinitionText,
  summarizeDefinition,
} from './concept-summary.ts';
import { ConceptSummaryCard } from './concept-summary-card.tsx';
import { RemoveConceptDialog } from './remove-concept-dialog.tsx';
import { type Concept, useRemoveConcept, useSaveConcept } from './use-concepts.ts';

/** How tall the definition box starts, in lines. */
const DEFINITION_ROWS = 24;
/** How tall it grows before it scrolls, in lines. */
const DEFINITION_MAX_ROWS = 48;

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

/** What the form holds. */
interface ConceptDraft {
  definition: string;
}

/**
 * The concept editor: the definition as JSON, Save, the problems the server located, and a summary of what the
 * definition says beside it.
 */
export function ConceptEditor({ concept }: ConceptEditorProps) {
  const navigate = useNavigate();
  const saveConcept = useSaveConcept();
  const removeConcept = useRemoveConcept();
  const [saveProblems, setSaveProblems] = useState<ConceptProblem[] | null>(null);
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const isEdit = concept !== undefined;

  const [savedText] = useState(() => formatDefinition(concept?.definition ?? STARTER_DEFINITION));
  // The form owns the text; this copy is for the summary, which redraws as it is typed.
  const [draftText, setDraftText] = useState(savedText);
  const defaultValues: ConceptDraft = { definition: savedText };
  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      const parsed = parseDefinitionText(value.definition);
      if (parsed.ok === false) {
        setServerError(parsed.message);
        return;
      }
      try {
        const saved = await saveConcept.mutateAsync(parsed.value);
        setSaveProblems(null);
        void navigate({ to: '/concepts/$name', params: { name: saved.name }, replace: true });
      } catch (error) {
        const located = conceptProblemsOf(error);
        if (located === null) {
          setServerError(messageOf(error) ?? 'The concept was not saved. Try again.');
        } else {
          setSaveProblems(located);
          setServerError(`It has ${countLabel(located.length, 'problem', 'problems')}, listed below.`);
        }
      }
    },
  });

  const draft = parseDefinitionText(draftText);
  const summary = summarizeDefinition(draft.ok ? draft.value : null);
  // After a refused save its problems are the news; before one, the stored concept's own.
  const problems = saveProblems ?? concept?.problems ?? [];
  const isRenamed = isEdit && summary.name !== null && summary.name !== concept.name;

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

  const editorCard = (
    <CardLayout
      title="Definition"
      description="JSON: the concept's name, its fields (shared by every member, or owned by one), and per member the fetch, create, update and delete documents in that upstream's schema, each binding $id. Saving checks every document against its upstream."
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <form className={className} onSubmit={onFormSubmit(() => form.handleSubmit())}>
            {parts}
          </form>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-4">
          <TextareaField
            form={form}
            name="definition"
            label="Definition"
            required
            // The control's own class is not a field prop, so the monospace face reaches it from the field.
            className="[&_textarea]:font-mono [&_textarea]:text-xs"
            rows={DEFINITION_ROWS}
            maxRows={DEFINITION_MAX_ROWS}
            spellCheck={false}
            listeners={{ onChange: ({ value }) => setDraftText(value) }}
            validators={{
              onChange: ({ value }) => {
                const parsed = parseDefinitionText(value);
                return parsed.ok ? undefined : `Not JSON yet: ${parsed.message}`;
              },
            }}
          />
          {isRenamed ? (
            <Alert
              variant="info"
              title="Saved under a new name"
              description={`Saving adds ${summary.name} as a concept of its own; ${concept.name} stays until you remove it.`}
            />
          ) : null}
          {serverError === undefined ? null : (
            <Alert variant="destructive" title="Not saved" description={serverError} />
          )}
          {problems.length === 0 ? null : (
            <Section
              level={3}
              title={saveProblems === null ? 'Problems now' : 'Problems in this draft'}
              description={
                saveProblems === null
                  ? 'Checked against the members as they are now, so it is not served until they are fixed.'
                  : 'From the save just refused. Lines count within the document named.'
              }
              contentSlot={<ConceptProblemList problems={problems} label="Concept problems" />}
            />
          )}
        </div>
      }
      footerActionsSlot={
        <form.SubmitButton
          variant={isEdit ? undefined : 'info'}
          isEdit={isEdit}
          createLabel="Save concept"
          loadingLabel="Checking…"
        />
      }
    />
  );

  return (
    <>
      <PageLayout
        title={concept?.name ?? 'New concept'}
        description={concept === undefined ? undefined : `${countLabel(summary.members.length, 'member', 'members')}.`}
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
            <div className="grid items-start gap-6 xl:grid-cols-2">
              {editorCard}
              <ConceptSummaryCard summary={summary} problems={problems} />
            </div>
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
