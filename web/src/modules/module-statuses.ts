import type { ModuleStatus } from '@/__generated__/graphql';
import type { StatusLook } from '@/components/ui/status-badge';

/** What each module status says, and its colour. The words carry the meaning; the colour only repeats it. */
export const MODULE_STATUSES: Record<ModuleStatus, StatusLook> = {
  READY: { label: 'Ready', variant: 'positive-soft' },
  FAILED: { label: "Doesn't compile", variant: 'destructive-soft' },
};
