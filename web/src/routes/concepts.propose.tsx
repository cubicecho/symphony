import { createFileRoute } from '@tanstack/react-router';
import { ProposeView } from '@/concepts/propose-view';

export const Route = createFileRoute('/concepts/propose')({ component: ProposeView });
