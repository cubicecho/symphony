import { useState } from 'react';
import { TextareaField, useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { CodeBlock } from '@/components/ui/code';
import { countLabel } from '@/core/format';
import { onFormSubmit } from '@/core/forms';
import { messageOf } from '@/lib/error-message';
import type { SlotNode } from '@/lib/utils';
import { ConceptProblemList } from './concept-problem-list.tsx';
import {
  type ConceptProblem,
  type ConceptSummary,
  conceptProblemsOf,
  formatDefinition,
  parseDefinitionText,
  summarizeDefinition,
} from './concept-summary.ts';
import { ConceptSummaryCard } from './concept-summary-card.tsx';

/** How tall the definition box starts, in lines. */
const DEFINITION_ROWS = 24;
/** How tall it grows before it scrolls, in lines. */
const DEFINITION_MAX_ROWS = 48;

/** What the definition card says a definition is, unless the screen says otherwise. */
const DEFINITION_DESCRIPTION =
  'JSON: the concept’s name, its fields (shared by every member, or owned by one), and per member the fetch, create, update and delete documents in that upstream’s schema, each binding $id. Saving checks every document against its upstream.';

/** How the stored problems are introduced, unless the screen says otherwise. */
const STORED_PROBLEMS = {
  title: 'Problems now',
  description: 'Checked against the members as they are now, so it is not served until they are fixed.',
};

/** What the draft is, for the actions beside Save. */
export interface DefinitionDraftState {
  /** The text differs from what the editor started with. */
  isChanged: boolean;
}

interface DefinitionEditorProps {
  /** The definition the editor starts from. */
  definition: unknown;
  /** The problems the stored definition has, placed in the summary until a save is refused. */
  problems: readonly ConceptProblem[];
  /** The heading and line over the stored problems. */
  problemsIntro?: { title: string; description: string } | undefined;
  /**
   * Saves the parsed definition. A thrown `RequestError` with `extensions.problems` is shown in place; any other
   * error by its message. Left out, the definition is read-only.
   */
  onSave?: ((definition: unknown) => Promise<void>) | undefined;
  /** What the definition card says above the box. */
  description?: string | undefined;
  /** Whether Save edits something stored, which words its button. */
  isEdit: boolean;
  /** Save's label when it creates. */
  createLabel: string;
  /** Save's label when it edits. */
  editLabel?: string | undefined;
  /** Drawn under the box, from what the draft says now: a rename, say. */
  noticeSlot?: ((summary: ConceptSummary) => SlotNode) | undefined;
  /** More buttons beside Save, told whether the draft has changed. */
  footerActionsSlot?: ((draft: DefinitionDraftState) => SlotNode) | undefined;
}

/**
 * A concept definition as JSON beside a summary of what it says: the problems the server located sit in the
 * summary, under the member and document they are in. Used for concepts and for proposals.
 */
export function DefinitionEditor({
  definition,
  problems: storedProblems,
  problemsIntro = STORED_PROBLEMS,
  onSave,
  description = DEFINITION_DESCRIPTION,
  isEdit,
  createLabel,
  editLabel,
  noticeSlot,
  footerActionsSlot,
}: DefinitionEditorProps) {
  const [saveProblems, setSaveProblems] = useState<ConceptProblem[] | null>(null);
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const [savedText] = useState(() => formatDefinition(definition));
  // The form owns the text; this copy is for the summary, which redraws as it is typed.
  const [draftText, setDraftText] = useState(savedText);
  const isReadOnly = onSave === undefined;
  const defaultValues = { definition: savedText };
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
        await onSave?.(parsed.value);
        setSaveProblems(null);
      } catch (error) {
        const located = conceptProblemsOf(error);
        if (located === null) {
          setServerError(messageOf(error) ?? 'It was not saved. Try again.');
        } else {
          setSaveProblems(located);
          setServerError(`It has ${countLabel(located.length, 'problem', 'problems')}, listed below.`);
        }
      }
    },
  });

  const draft = parseDefinitionText(draftText);
  const summary = summarizeDefinition(draft.ok ? draft.value : null);
  // After a refused save its problems are the news; before one, the stored definition's own.
  const problems = saveProblems ?? storedProblems;
  const intro =
    saveProblems === null
      ? problemsIntro
      : {
          title: 'Problems in this draft',
          description: 'From the save just refused. Lines count within the document named.',
        };

  const problemSection =
    problems.length === 0 ? null : (
      <Section
        level={3}
        title={intro.title}
        description={intro.description}
        contentSlot={<ConceptProblemList problems={problems} label="Concept problems" />}
      />
    );

  const editorCard = isReadOnly ? (
    <CardLayout
      title="Definition"
      description="Read-only."
      contentSlot={
        <div className="grid gap-4">
          <CodeBlock content={savedText} language="json" title="definition" />
          {problemSection}
        </div>
      }
    />
  ) : (
    <CardLayout
      title="Definition"
      description={description}
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
          {noticeSlot?.(summary)}
          {serverError === undefined ? null : (
            <Alert variant="destructive" title="Not saved" description={serverError} />
          )}
          {problemSection}
        </div>
      }
      footerActionsSlot={
        <>
          {footerActionsSlot?.({ isChanged: draftText !== savedText })}
          <form.SubmitButton
            variant={isEdit ? undefined : 'info'}
            isEdit={isEdit}
            createLabel={createLabel}
            editLabel={editLabel}
            loadingLabel="Checking…"
          />
        </>
      }
    />
  );

  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      {editorCard}
      <ConceptSummaryCard summary={summary} problems={problems} />
    </div>
  );
}
