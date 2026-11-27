import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface RemoveConceptDialogProps {
  /** The concept's name, typed to confirm. */
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/** Asks before a concept is removed, once its name is typed. */
export function RemoveConceptDialog({ name, open, onOpenChange, onConfirm }: RemoveConceptDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${name}?`}
      description="The unified API stops serving it. The members' own data is not touched."
      confirmLabel="Remove concept"
      requireText={name}
      onConfirm={onConfirm}
    />
  );
}
