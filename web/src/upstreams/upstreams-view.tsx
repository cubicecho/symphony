import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Ellipsis, Eye, Pencil, Plus, RefreshCw, Server, Trash2 } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { countLabel, formatDateTime } from '@/core/format';
import { ProblemAlert } from '@/core/problem-alert';
import { messageOf } from '@/lib/error-message';
import { SchemaDialog } from './schema-dialog.tsx';
import { UpstreamDialog } from './upstream-dialog.tsx';
import { type Upstream, useDeleteUpstream, useRefreshSchema, useUpstreams } from './use-upstreams.ts';

/** Which dialog the screen has open, fresh each time by its session. */
type OpenDialog =
  | { kind: 'edit'; upstream: Upstream | undefined; session: number }
  | { kind: 'schema'; upstream: Upstream; session: number }
  | null;

/** The upstreams screen: every wrapped GraphQL API, its schema's state, and adding, editing, refreshing and deleting them. */
export function UpstreamsView() {
  const query = useUpstreams();
  const upstreams = query.data ?? [];
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [sessions, setSessions] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Opens a dialog with a fresh form.
   *
   * @param next - Which one, without its session.
   */
  const openDialog = (
    next: { kind: 'edit'; upstream: Upstream | undefined } | { kind: 'schema'; upstream: Upstream },
  ) => {
    setSessions(sessions + 1);
    setDialog({ ...next, session: sessions + 1 });
  };

  /**
   * Closes whichever dialog is open, when it says it closed.
   *
   * @param isOpen - What the dialog asked for.
   */
  const onDialogOpenChange = (isOpen: boolean): void => {
    if (isOpen === false) {
      setDialog(null);
    }
  };

  return (
    <>
      <PageLayout
        title="Upstreams"
        description="The GraphQL APIs modules read. Symphony keeps each one's schema, and sends modules' queries to it."
        actionSlot={
          <Button
            size="sm"
            variant="info"
            iconSlot={<Plus />}
            content="Add upstream"
            onClick={() => openDialog({ kind: 'edit', upstream: undefined })}
          />
        }
        contentSlot={
          <>
            <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} />
            <LoadState
              query={query}
              what="your upstreams"
              count={upstreams.length}
              emptySlot={
                <EmptyState
                  iconSlot={<Server />}
                  title="No upstreams yet"
                  description="Add the GraphQL API you want modules to show. Its schema is fetched as it is added."
                  actionSlot={
                    <Button
                      variant="info"
                      iconSlot={<Plus />}
                      content="Add upstream"
                      onClick={() => openDialog({ kind: 'edit', upstream: undefined })}
                    />
                  }
                />
              }
            />
            {upstreams.length === 0 ? null : (
              <List
                label="Upstreams"
                contentSlot={upstreams.map((upstream) => (
                  <UpstreamRow
                    key={upstream.id}
                    upstream={upstream}
                    onEdit={() => openDialog({ kind: 'edit', upstream })}
                    onViewSchema={() => openDialog({ kind: 'schema', upstream })}
                    onProblem={setProblem}
                  />
                ))}
              />
            )}
          </>
        }
      />
      {dialog?.kind === 'edit' ? (
        <UpstreamDialog key={dialog.session} open onOpenChange={onDialogOpenChange} upstream={dialog.upstream} />
      ) : null}
      {dialog?.kind === 'schema' ? (
        <SchemaDialog key={dialog.session} open onOpenChange={onDialogOpenChange} upstream={dialog.upstream} />
      ) : null}
    </>
  );
}

interface UpstreamRowProps {
  upstream: Upstream;
  onEdit: () => void;
  onViewSchema: () => void;
  /** Told what went wrong when a refresh or a delete fails. */
  onProblem: (problem: string) => void;
}

/** One upstream: its name and address, its schema's state, Refresh, and a menu of the rest. */
function UpstreamRow({ upstream, onEdit, onViewSchema, onProblem }: UpstreamRowProps) {
  const refreshSchema = useRefreshSchema();
  const deleteUpstream = useDeleteUpstream();
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const { schema } = upstream;

  /** Introspects the upstream again, and says so when it fails. */
  const refresh = (): void => {
    refreshSchema.mutate(upstream.id, {
      onError: (error) => onProblem(`Couldn't refresh ${upstream.name}'s schema. ${messageOf(error) ?? ''}`.trim()),
    });
  };

  /** Deletes the upstream, and says so when the server refuses. */
  const remove = (): void => {
    deleteUpstream.mutate(upstream.id, {
      onError: (error) => onProblem(`Couldn't delete ${upstream.name}. ${messageOf(error) ?? ''}`.trim()),
    });
  };

  const schemaState =
    schema === null ? (
      <Badge variant="warning-soft">Schema not fetched</Badge>
    ) : (
      <span className="text-foreground/60 text-xs">
        {countLabel(schema.typeCount, 'type', 'types')}, fetched {formatDateTime(schema.fetchedAt)}
      </span>
    );

  return (
    <>
      <ListItem
        title={upstream.name}
        description={<span className="break-all">{upstream.url}</span>}
        meta={schemaState}
        actionSlot={
          <>
            <Button
              size="sm"
              variant="outline"
              iconSlot={<RefreshCw />}
              content="Refresh schema"
              loading={refreshSchema.isPending}
              loadingLabel="Refreshing…"
              onClick={refresh}
            />
            <Menu>
              <MenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${upstream.name}`}
                  iconSlot={<Ellipsis />}
                />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem iconSlot={<Pencil />} label="Edit" onSelect={onEdit} />
                <MenuItem iconSlot={<Eye />} label="View schema" disabled={schema === null} onSelect={onViewSchema} />
                <MenuSeparator />
                <MenuItem
                  iconSlot={<Trash2 />}
                  label="Delete"
                  destructive
                  onSelect={() => setIsConfirmingDelete(true)}
                />
              </MenuContent>
            </Menu>
          </>
        }
      />
      <ConfirmDialog
        open={isConfirmingDelete}
        onOpenChange={setIsConfirmingDelete}
        title={`Delete ${upstream.name}?`}
        description="Its modules are deleted with it, and taken off every page they are on. This can't be undone."
        confirmLabel="Delete upstream"
        requireText={upstream.name}
        onConfirm={remove}
      />
    </>
  );
}
