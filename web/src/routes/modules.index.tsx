import { createFileRoute } from '@tanstack/react-router';
import { ModulesView } from '@/modules/modules-view';

export const Route = createFileRoute('/modules/')({ component: ModulesView });
