import { createFileRoute } from '@tanstack/react-router';
import { WiringView } from '@/concepts/wiring-view';

export const Route = createFileRoute('/wiring')({ component: WiringView });
