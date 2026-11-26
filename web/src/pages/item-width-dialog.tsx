import { useState } from 'react';
import { SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { onFormSubmit } from '@/core/forms';
import { messageOf } from '@/lib/error-message';
import { widthChoiceOf, widthFromChoice, widthOptions } from './column-span.ts';
import { type Item, useLimits, useUpdateItem } from './use-pages.ts';

interface ItemWidthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: Item;
}

/** Changes how many columns an item spans, or makes it full width. */
export function ItemWidthDialog({ open, onOpenChange, item }: ItemWidthDialogProps) {
  const limits = useLimits().data;
  const updateItem = useUpdateItem();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const form = useAppForm({
    defaultValues: { width: widthChoiceOf(item) },
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      try {
        await updateItem.mutateAsync({ id: item.id, ...widthFromChoice(value.width, item.columnSpan) });
        onOpenChange(false);
      } catch (error) {
        setServerError(messageOf(error) ?? 'The width was not saved. Try again.');
      }
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Width of ${item.module.name}`}
      description="On a narrow screen an item never takes more columns than there are."
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
          <SelectField
            form={form}
            name="width"
            label="Width"
            loading={limits === undefined}
            options={widthOptions(limits?.maxColumns ?? item.columnSpan)}
          />
          {serverError === undefined ? null : (
            <Alert variant="destructive" title="Not saved" description={serverError} />
          )}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton isEdit requireChanges />
        </>
      )}
    />
  );
}
