import { useState } from 'react';
import { TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { onFormSubmit } from '@/core/forms';
import { messageOf } from '@/lib/error-message';
import { useRejectConceptProposal } from './use-concept-proposals.ts';

/** How tall the reason box starts, in lines. */
const REASON_ROWS = 3;

interface RejectProposalDialogProps {
  /** The proposal to reject. */
  id: string;
  /** Its name, for the title. */
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Rejects a pending proposal, with an optional reason kept beside it. */
export function RejectProposalDialog({ id, name, open, onOpenChange }: RejectProposalDialogProps) {
  const reject = useRejectConceptProposal();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const form = useAppForm({
    defaultValues: { reason: '' },
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      const reason = value.reason.trim();
      try {
        await reject.mutateAsync({ id, reason: reason === '' ? undefined : reason });
        onOpenChange(false);
      } catch (error) {
        setServerError(messageOf(error) ?? 'It was not rejected. Try again.');
      }
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Reject ${name}?`}
      description="It stays in the list as rejected, with the reason, and is never saved as a concept."
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
            name="reason"
            label="Reason"
            description="Optional. An agent that proposed it can read it."
            rows={REASON_ROWS}
            autoFocus
          />
          {serverError === undefined ? null : (
            <Alert variant="destructive" title="Not rejected" description={serverError} />
          )}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton variant="destructive" createLabel="Reject proposal" loadingLabel="Rejecting…" />
        </>
      )}
    />
  );
}
