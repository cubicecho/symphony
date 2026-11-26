import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { X } from '@/components/ui/icons';

interface ProblemAlertProps {
  /** What went wrong, in the reader's words; null draws nothing. */
  problem: string | null;
  /** Hides it. */
  onDismiss: () => void;
}

/**
 * A failed action that has no surface of its own (a refresh, a move, a delete), said at the top of the screen
 * until it is dismissed.
 *
 * @remarks
 * A toast would be the usual place; cubeui's toast is not installed in this app yet.
 */
export function ProblemAlert({ problem, onDismiss }: ProblemAlertProps) {
  if (problem === null) {
    return null;
  }
  return (
    <Alert
      variant="destructive"
      title="That didn't work"
      description={problem}
      actionSlot={<Button variant="ghost" size="icon-xs" aria-label="Dismiss" iconSlot={<X />} onClick={onDismiss} />}
    />
  );
}
