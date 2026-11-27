import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { ComboboxField, InputField, SelectField, TextareaField, useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ArrowLeft, Server, Trash2 } from '@/components/ui/icons';
import type { TextareaHandle, TextareaSelection } from '@/components/ui/textarea-base';
import { onFormSubmit } from '@/core/forms';
import { ProblemAlert } from '@/core/problem-alert';
import { messageOf } from '@/lib/error-message';
import { useLimits } from '@/pages/use-pages';
import { useUpstreams } from '@/upstreams/use-upstreams';
import { CompileErrorList } from './compile-error-list.tsx';
import { EXAMPLE_SOURCE } from './example-source.ts';
import { McpNote } from './mcp-note.tsx';
import { ModuleCard } from './module-card.tsx';
import { ModuleStatusBadge } from './module-status-badge.tsx';
import { type ModuleDetail, useDeleteModule, useSaveModule } from './use-modules.ts';

/** How tall the source box starts, in lines. */
const SOURCE_ROWS = 24;
/** How tall the source box grows before it scrolls, in lines. */
const SOURCE_MAX_ROWS = 48;

interface ModuleEditorProps {
  /** The module as last saved. Left out, the editor creates one. */
  module?: ModuleDetail | undefined;
}

/** What the form holds. */
interface ModuleDraft {
  name: string;
  description: string;
  /** The default upstream: plain `gql` documents go to it. */
  upstreamId: string;
  /** The other upstreams, in the order chosen: `gql.from('<name>')` documents go to them. */
  otherUpstreamIds: string[];
  source: string;
}

/**
 * Puts a module's upstreams in the order the server takes them.
 *
 * @param draft - The form's values.
 * @returns The default first, then the others, without it.
 */
function upstreamIdsOf(draft: Pick<ModuleDraft, 'upstreamId' | 'otherUpstreamIds'>): string[] {
  return [draft.upstreamId, ...draft.otherUpstreamIds.filter((id) => id !== draft.upstreamId)];
}

/**
 * Finds the offset of a line and column in a text.
 *
 * @param text - The source.
 * @param line - The line, from 1.
 * @param column - The column, from 1.
 * @returns The character offset, clamped to the text.
 */
function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split('\n');
  const before = lines.slice(0, Math.max(0, line - 1)).reduce((sum, current) => sum + current.length + 1, 0);
  return Math.min(text.length, before + Math.max(0, column - 1));
}

/**
 * The module editor: name, description, upstreams and source, Save & compile, the last save's errors, and a
 * live preview of the last version that compiled.
 */
export function ModuleEditor({ module }: ModuleEditorProps) {
  const navigate = useNavigate();
  const upstreamsQuery = useUpstreams();
  const limits = useLimits().data;
  const saveModule = useSaveModule();
  const deleteModule = useDeleteModule();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [selection, setSelection] = useState<TextareaSelection | undefined>(undefined);
  const sourceRef = useRef<TextareaHandle>(null);
  const isEdit = module !== undefined;
  const upstreams = upstreamsQuery.data ?? [];

  const defaultValues: ModuleDraft = {
    name: module?.name ?? '',
    description: module?.description ?? '',
    upstreamId: module?.upstreams[0]?.id ?? (upstreams.length === 1 ? (upstreams[0]?.id ?? '') : ''),
    otherUpstreamIds: module?.upstreams.slice(1).map((upstream) => upstream.id) ?? [],
    source: module?.source ?? EXAMPLE_SOURCE,
  };
  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      try {
        const saved = await saveModule.mutateAsync({
          ...(isEdit ? { id: module.id } : {}),
          name: value.name.trim(),
          description: value.description.trim(),
          upstreamIds: upstreamIdsOf(value),
          source: value.source,
        });
        if (isEdit === false) {
          void navigate({ to: '/modules/$id', params: { id: saved.id }, replace: true });
        }
      } catch (error) {
        setServerError(messageOf(error) ?? 'The module was not saved. Try again.');
      }
    },
  });

  /**
   * Puts the caret at a place in the source and focuses it.
   *
   * @param line - The line, from 1.
   * @param column - The column, from 1.
   */
  const jumpTo = (line: number, column: number): void => {
    const offset = offsetOf(form.getFieldValue('source'), line, column);
    setSelection({ start: offset, end: offset });
    sourceRef.current?.focus();
  };

  /** Deletes the module and goes back to the list, or says why not. */
  const remove = (): void => {
    if (module === undefined) {
      return;
    }
    deleteModule.mutate(module.id, {
      onSuccess: () => void navigate({ to: '/modules' }),
      onError: (error) => setProblem(`Couldn't delete ${module.name}. ${messageOf(error) ?? ''}`.trim()),
    });
  };

  const maxSourceChars = limits?.maxSourceChars;
  const hasErrors = module !== undefined && module.errors.length > 0;

  const editorCard = (
    <CardLayout
      title="Source"
      description="One TSX file with a default export. Saving checks each document against its upstream's schema and compiles it."
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <form className={className} onSubmit={onFormSubmit(() => form.handleSubmit())}>
            {parts}
          </form>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-4">
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            placeholder="Recent orders"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Give the module a name.' : undefined) }}
          />
          <InputField
            form={form}
            name="description"
            label="Description"
            placeholder="What it shows, for whoever places it on a page"
          />
          <SelectField
            form={form}
            name="upstreamId"
            label="Default upstream"
            description="Plain gql documents go here."
            required
            loading={upstreamsQuery.isPending}
            placeholder="Choose the API it reads"
            options={upstreams.map((upstream) => ({ value: upstream.id, label: upstream.name }))}
            validators={{ onChange: ({ value }) => (value === '' ? 'Choose the upstream it reads.' : undefined) }}
          />
          <form.Subscribe selector={(state) => state.values.upstreamId}>
            {(defaultId) => (
              <ComboboxField
                form={form}
                name="otherUpstreamIds"
                label="Other upstreams"
                description="Optional. A document for one of these is written gql.from('<name>')`…`."
                multiple
                placeholder="None"
                options={upstreams
                  .filter((upstream) => upstream.id !== defaultId)
                  .map((upstream) => ({ value: upstream.id, label: upstream.name }))}
              />
            )}
          </form.Subscribe>
          <TextareaField
            form={form}
            name="source"
            label="Source"
            required
            // The control's own class is not a field prop, so the monospace face reaches it from the field.
            className="[&_textarea]:font-mono [&_textarea]:text-xs"
            rows={SOURCE_ROWS}
            maxRows={SOURCE_MAX_ROWS}
            spellCheck={false}
            ref={sourceRef}
            selection={selection}
            onSelectionChange={setSelection}
            validators={{
              onChange: ({ value }) => {
                if (value.trim() === '') {
                  return 'A module needs its source.';
                }
                const isTooLong = maxSourceChars !== undefined && value.length > maxSourceChars;
                return isTooLong ? `Keep it under ${maxSourceChars.toLocaleString()} characters.` : undefined;
              },
            }}
          />
          {serverError === undefined ? null : (
            <Alert variant="destructive" title="Not saved" description={serverError} />
          )}
          {hasErrors ? (
            <Section
              title="Compile errors"
              description="From the last save. Pick one with a place to move the caret there."
              contentSlot={<CompileErrorList errors={module.errors} onJump={jumpTo} />}
            />
          ) : null}
        </div>
      }
      footerActionsSlot={
        <form.SubmitButton content="Save & compile" loadingLabel="Compiling…" disabled={upstreams.length === 0} />
      }
    />
  );

  const previewCard = (
    <CardLayout
      title="Preview"
      description="The last version that compiled, with live data. Save to see your changes."
      contentSlot={
        module?.status === 'READY' ? (
          <ModuleCard module={module} />
        ) : (
          <EmptyState
            compact
            title={isEdit ? 'Nothing to preview: the last save did not compile.' : 'Save the module to see it here.'}
          />
        )
      }
    />
  );

  return (
    <>
      <PageLayout
        title={module?.name ?? 'New module'}
        description={
          module === undefined
            ? undefined
            : `Version ${module.version}, reading ${module.upstreams.map((upstream) => upstream.name).join(', ')}.`
        }
        backSlot={
          <Button
            variant="ghost"
            size="sm"
            iconSlot={<ArrowLeft />}
            content="Modules"
            linkSlot={<Link to="/modules" />}
          />
        }
        actionSlot={
          module === undefined ? null : (
            <>
              <ModuleStatusBadge status={module.status} />
              <Button
                size="sm"
                variant="outline"
                iconSlot={<Trash2 />}
                content="Delete"
                onClick={() => setIsConfirmingDelete(true)}
              />
            </>
          )
        }
        contentSlot={
          <>
            <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} />
            <McpNote />
            {upstreamsQuery.isSuccess && upstreams.length === 0 ? (
              <EmptyState
                iconSlot={<Server />}
                title="Add an upstream first"
                description="A module reads at least one GraphQL API, so there has to be one to choose."
                actionSlot={<Button variant="info" linkSlot={<Link to="/upstreams" />} content="Go to Upstreams" />}
              />
            ) : null}
            <div className="grid items-start gap-6 xl:grid-cols-2">
              {editorCard}
              {previewCard}
            </div>
          </>
        }
      />
      {module === undefined ? null : (
        <ConfirmDialog
          open={isConfirmingDelete}
          onOpenChange={setIsConfirmingDelete}
          title={`Delete ${module.name}?`}
          description="It is taken off every page it is on. This can't be undone."
          confirmLabel="Delete module"
          onConfirm={remove}
        />
      )}
    </>
  );
}
