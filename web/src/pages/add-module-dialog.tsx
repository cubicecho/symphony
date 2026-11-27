import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Blocks } from '@/core/app-icons';
import { onFormSubmit } from '@/core/forms';
import { messageOf } from '@/lib/error-message';
import { useModules } from '@/modules/use-modules';
import { columnsLabel, widthFromChoice, widthOptions } from './column-span.ts';
import { type Page, useAddItem, useLimits } from './use-pages.ts';

/** The status of a module that compiles, so it can be placed. */
const READY = 'READY';

interface AddModuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page it goes on, at the end. */
  page: Page;
}

/** Places a module that compiles on a page, at a chosen width. */
export function AddModuleDialog({ open, onOpenChange, page }: AddModuleDialogProps) {
  const modulesQuery = useModules();
  const limits = useLimits().data;
  const addItem = useAddItem();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const ready = (modulesQuery.data ?? []).filter((module) => module.status === READY);
  const newItemColumns = limits?.newItemColumns ?? 1;

  const form = useAppForm({
    defaultValues: { moduleId: '', width: '' },
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      const width = widthFromChoice(value.width === '' ? String(newItemColumns) : value.width, newItemColumns);
      try {
        await addItem.mutateAsync({ pageSlug: page.slug, moduleId: value.moduleId, ...width });
        onOpenChange(false);
      } catch (error) {
        setServerError(messageOf(error) ?? 'The module was not added. Try again.');
      }
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Add a module to ${page.title}`}
      description="Only modules that compile are listed."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <form className={className} onSubmit={onFormSubmit(() => form.handleSubmit())}>
            {parts}
          </form>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-4">
          <LoadState
            query={modulesQuery}
            what="your modules"
            count={ready.length}
            emptySlot={
              <EmptyState
                iconSlot={<Blocks />}
                title="No module compiles yet"
                description="Write one, or ask an agent to submit one over MCP."
                actionSlot={<Button variant="outline" linkSlot={<Link to="/modules/new" />} content="New module" />}
              />
            }
          />
          {ready.length === 0 ? null : (
            <>
              <SelectField
                form={form}
                name="moduleId"
                label="Module"
                required
                placeholder="Choose a module"
                options={ready.map((module) => ({
                  value: module.id,
                  label: `${module.name} (${module.upstreams.map((upstream) => upstream.name).join(', ')})`,
                }))}
                validators={{ onChange: ({ value }) => (value === '' ? 'Choose a module.' : undefined) }}
              />
              <SelectField
                form={form}
                name="width"
                label="Width"
                placeholder={columnsLabel(newItemColumns)}
                options={widthOptions(limits?.maxColumns ?? newItemColumns)}
              />
            </>
          )}
          {serverError === undefined ? null : (
            <Alert variant="destructive" title="Not added" description={serverError} />
          )}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          {ready.length === 0 ? null : (
            <form.SubmitButton variant="info" isEdit={false} createLabel="Add module" loadingLabel="Adding…" />
          )}
        </>
      )}
    />
  );
}
