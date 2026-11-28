import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Ellipsis, Eye, Pencil, Plus, RefreshCw, Server, Trash2 } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { ProblemAlert } from '@/core/problem-alert';
import { messageOf } from '@/lib/error-message';
import { formatCount, formatDateTime } from '@/lib/format';
import { SchemaDialog } from './schema-dialog.tsx';
import { UpstreamDialog } from './upstream-dialog.tsx';
import {
  type DiscoveredUpstream,
  type Upstream,
  useDeleteUpstream,
  useLanDiscovery,
  useRefreshSchema,
  useUpstreams,
} from './use-upstreams.ts';

/** Which dialog the screen has open, fresh each time by its session. */
type OpenDialog =
  | { kind: 'edit'; upstream: Upstream | undefined; session: number }
  | { kind: 'discovered'; found: DiscoveredUpstream; session: number }
  | { kind: 'schema'; upstream: Upstream; session: number }
  | null;

/** The upstreams screen: every wrapped GraphQL API, its schema's state, and adding, editing, refreshing and deleting them. */
export function UpstreamsView() {
  const query = useUpstreams();
  const upstreams = query.data ?? [];
  // The built-in unified API is listed beside them, but has nothing to serve until one is added.
  const addedCount = upstreams.filter((upstream) => upstream.builtIn === false).length;
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [sessions, setSessions] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Opens a dialog with a fresh form.
   *
   * @param next - Which one, without its session.
   */
  const openDialog = (
    next:
      | { kind: 'edit'; upstream: Upstream | undefined }
      | { kind: 'discovered'; found: DiscoveredUpstream }
      | { kind: 'schema'; upstream: Upstream },
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
              count={addedCount}
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
            {addedCount === 0 ? null : (
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
            <OnYourNetwork onAdd={(found) => openDialog({ kind: 'discovered', found })} />
          </>
        }
      />
      {dialog?.kind === 'edit' ? (
        <UpstreamDialog key={dialog.session} open onOpenChange={onDialogOpenChange} upstream={dialog.upstream} />
      ) : null}
      {dialog?.kind === 'discovered' ? (
        <UpstreamDialog key={dialog.session} open onOpenChange={onDialogOpenChange} discovered={dialog.found} />
      ) : null}
      {dialog?.kind === 'schema' ? (
        <SchemaDialog key={dialog.session} open onOpenChange={onDialogOpenChange} upstream={dialog.upstream} />
      ) : null}
    </>
  );
}

/** How each state of a found API is shown. */
const FOUND_BADGES = {
  NEW: { label: 'New', variant: 'info-soft' },
  NEEDS_TOKEN: { label: 'Needs a token', variant: 'warning-soft' },
  LINKED: { label: 'Added', variant: 'positive-soft' },
  OFFLINE: { label: 'Offline', variant: 'destructive-soft' },
} as const satisfies Record<DiscoveredUpstream['state'], { label: string; variant: string }>;

interface OnYourNetworkProps {
  /** Opens the dialog that adds a found API. */
  onAdd: (found: DiscoveredUpstream) => void;
}

/**
 * The GraphQL APIs other machines advertise on the LAN, each with an Add. Drawn only while discovery is on
 * (`LAN_DISCOVER=true`) and has found something.
 */
function OnYourNetwork({ onAdd }: OnYourNetworkProps) {
  const query = useLanDiscovery();
  const found = query.data?.upstreams ?? [];
  const isShown = query.data?.enabled === true && found.length > 0;
  if (isShown === false) {
    return null;
  }
  return (
    <Section
      level={2}
      title="On your network"
      description="GraphQL APIs other machines advertise over mDNS. Adding one makes it an upstream that follows the API if its address changes."
      contentSlot={
        <List
          label="Found on your network"
          contentSlot={found.map((api) => <FoundRow key={api.key} found={api} onAdd={() => onAdd(api)} />)}
        />
      }
    />
  );
}

interface FoundRowProps {
  found: DiscoveredUpstream;
  onAdd: () => void;
}

/** One found API: what it calls itself, where it is, where it stands, and Add while it can be added. */
function FoundRow({ found, onAdd }: FoundRowProps) {
  const badge = FOUND_BADGES[found.state];
  const canAdd = found.state === 'NEW' || found.state === 'NEEDS_TOKEN';
  const linkedName = found.upstream?.name;
  return (
    <ListItem
      title={found.title ?? found.serviceName}
      description={
        <span className="break-all">
          {found.url} · {linkedName === undefined ? found.host : `added as ${linkedName}`}
        </span>
      }
      meta={<Badge variant={badge.variant}>{badge.label}</Badge>}
      actionSlot={
        canAdd ? <Button size="sm" variant="outline" iconSlot={<Plus />} content="Add" onClick={onAdd} /> : null
      }
    />
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
  const { schema, builtIn } = upstream;

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
      <Badge variant="warning-soft">{builtIn ? 'Not composed yet' : 'Schema not fetched'}</Badge>
    ) : (
      <span className="text-foreground/60 text-xs">
        {formatCount(schema.typeCount, 'type')}, fetched {formatDateTime(schema.fetchedAt)}
      </span>
    );

  return (
    <>
      <ListItem
        title={upstream.name}
        description={<span className="break-all">{upstream.url}</span>}
        meta={
          builtIn ? (
            <>
              <Badge variant="info-soft">Built in</Badge> {schemaState}
            </>
          ) : (
            schemaState
          )
        }
        actionSlot={
          builtIn ? (
            <Button
              size="sm"
              variant="outline"
              iconSlot={<Eye />}
              content="View schema"
              disabled={schema === null}
              onClick={onViewSchema}
            />
          ) : (
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
          )
        }
      />
      <ConfirmDialog
        open={isConfirmingDelete}
        onOpenChange={setIsConfirmingDelete}
        title={`Delete ${upstream.name}?`}
        description="Every module that reads it, as its default upstream or beside others, is deleted with it and taken off every page it is on. This can't be undone."
        confirmLabel="Delete upstream"
        requireText={upstream.name}
        onConfirm={remove}
      />
    </>
  );
}
