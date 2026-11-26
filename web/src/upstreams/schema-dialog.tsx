import { DialogLayout } from '@/components/dialog-layout';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { type Upstream, useUpstreamSdl } from './use-upstreams.ts';

interface SchemaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  upstream: Upstream;
}

/** An upstream's cached schema, printed as SDL, as modules are checked against it. */
export function SchemaDialog({ open, onOpenChange, upstream }: SchemaDialogProps) {
  const query = useUpstreamSdl(upstream.id, open);
  const sdl = query.data ?? null;

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={`${upstream.name} schema`}
      description="As Symphony last fetched it. Refresh the schema after the upstream changes."
      contentSlot={
        <>
          <LoadState
            query={query}
            what="the schema"
            count={sdl === null ? 0 : 1}
            emptySlot={<EmptyState compact title="Not fetched yet. Refresh the schema to fetch it." />}
          />
          {sdl === null ? null : <CodeBlock content={sdl} language="graphql" title="schema.graphql" />}
        </>
      }
      footerActionsSlot={(close) => <Button variant="outline" onClick={close} content="Close" />}
    />
  );
}
