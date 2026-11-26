import { createFileRoute } from '@tanstack/react-router';
import { UpstreamsView } from '@/upstreams/upstreams-view';

export const Route = createFileRoute('/upstreams')({ component: UpstreamsView });
