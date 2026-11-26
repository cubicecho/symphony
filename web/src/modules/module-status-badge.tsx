import { Badge } from '@/components/ui/badge';

/** What each status says, and its colour. The words carry the meaning; the colour only repeats it. */
const STATUS_BADGES = {
  READY: { label: 'Ready', variant: 'positive-soft' },
  FAILED: { label: "Doesn't compile", variant: 'destructive-soft' },
} as const;

interface ModuleStatusBadgeProps {
  /** The module's status. */
  status: keyof typeof STATUS_BADGES;
}

/** A module's status as a soft badge: a dot and a word. */
export function ModuleStatusBadge({ status }: ModuleStatusBadgeProps) {
  const { label, variant } = STATUS_BADGES[status];
  return <Badge variant={variant}>{label}</Badge>;
}
