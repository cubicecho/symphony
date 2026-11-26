import { useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { onFormSubmit } from '@/core/forms';
import { messageOf } from '@/lib/error-message';
import { type Page, useAddPage } from './use-pages.ts';

interface PageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Told the page as the server saved it, after the dialog closes. */
  onSaved?: ((page: Page) => void) | undefined;
}

/** Adds a page: its title, from which the server makes its address. */
export function PageDialog({ open, onOpenChange, onSaved }: PageDialogProps) {
  const addPage = useAddPage();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const form = useAppForm({
    defaultValues: { title: '' },
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      try {
        const page = await addPage.mutateAsync(value.title.trim());
        onOpenChange(false);
        onSaved?.(page);
      } catch (error) {
        setServerError(messageOf(error) ?? 'The page was not added. Try again.');
      }
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title="New page"
      description="A page holds modules side by side, and gets a place in the sidebar."
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
          <InputField
            form={form}
            name="title"
            label="Title"
            required
            autoFocus
            placeholder="Operations"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Give the page a title.' : undefined) }}
          />
          {serverError === undefined ? null : (
            <Alert variant="destructive" title="Not added" description={serverError} />
          )}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton variant="info" createLabel="Add page" isEdit={false} loadingLabel="Adding…" />
        </>
      )}
    />
  );
}
