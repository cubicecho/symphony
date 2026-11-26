import { createFileRoute } from '@tanstack/react-router';
import { ModuleEditor } from '@/modules/module-editor';

export const Route = createFileRoute('/modules/new')({ component: NewModuleRoute });

/** A new module, prefilled with a working example. */
function NewModuleRoute() {
  return <ModuleEditor />;
}
