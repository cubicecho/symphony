import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { CardLayout } from '@/components/card-layout';
import { Collapsible } from '@/components/collapsible';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { GitBranch, Pencil, Plus, Undo2 } from '@/components/ui/icons';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ProblemAlert } from '@/core/problem-alert';
import { messageOf } from '@/lib/error-message';
import { useUpstreams } from '@/upstreams/use-upstreams';
import { type UnifiedProblem, UnifiedProblemList } from './unified-status-card.tsx';
import { type SourceWiring, useClearWiringOverride, useSourceWiring, useUnifiedStatus } from './use-concepts.ts';
import { WiringDialog } from './wiring-dialog.tsx';
import { type WiringEntryKind, type WiringRow, type WiringRowOrigin, wiringRows } from './wiring-rows.ts';

/** The source the concept subgraph is composed under, which can be wired like an upstream. */
const CONCEPT_SOURCE = 'symphony_concepts';

/** What each kind of row is called. */
const KIND_LABELS: Readonly<Record<WiringEntryKind, string>> = { type: 'Type', field: 'Field', key: 'Merge key' };

/** How each origin is drawn. The words carry the meaning; the colour repeats it. */
const ORIGIN_BADGES = {
  generated: { label: 'Generated', variant: 'info-soft' },
  override: { label: 'Override', variant: 'warning-soft' },
  removed: { label: 'Removed by override', variant: 'destructive-soft' },
} as const satisfies Record<WiringRowOrigin, { label: string; variant: string }>;

/** Which dialog the screen has open, fresh each time by its session. */
type OpenDialog = { wiring: SourceWiring | undefined; session: number } | null;

/** The wiring screen: per source, the renames and merge keys the unified API composes it with, and the override. */
export function WiringView() {
  const query = useSourceWiring();
  const statusQuery = useUnifiedStatus();
  const upstreamsQuery = useUpstreams();
  const wirings = query.data ?? [];
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [sessions, setSessions] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const wiringProblems = (statusQuery.data?.problems ?? []).filter((one) => one.kind === 'WIRING');
  const wiredSources = new Set(wirings.map((wiring) => wiring.source));
  const unwiredSources = [...(upstreamsQuery.data ?? []).map((upstream) => upstream.name), CONCEPT_SOURCE].filter(
    (source) => wiredSources.has(source) === false,
  );
  // A problem about a source the derivation could not wire at all has no card to sit in.
  const unplacedProblems = wiringProblems.filter(
    (one) => one.source === null || wiredSources.has(one.source) === false,
  );

  /**
   * Opens the wiring dialog with a fresh form.
   *
   * @param wiring - The source to edit, or undefined to wire a new one.
   */
  const openDialog = (wiring: SourceWiring | undefined): void => {
    setSessions(sessions + 1);
    setDialog({ wiring, session: sessions + 1 });
  };

  return (
    <>
      <PageLayout
        title="Wiring"
        description="How each source's types and fields are named in the unified API, and how entities are merged across sources. Concepts generate it; an override changes it."
        actionSlot={
          <Button
            size="sm"
            variant="info"
            iconSlot={<Plus />}
            content="Wire a source"
            disabled={unwiredSources.length === 0}
            onClick={() => openDialog(undefined)}
          />
        }
        contentSlot={
          <>
            <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} />
            {unplacedProblems.length === 0 ? null : (
              <Section
                title="Not wired"
                description="What the concepts' documents did not let Symphony derive. Fix the concept, or wire the source by hand."
                contentSlot={<UnifiedProblemList problems={unplacedProblems} label="Wiring problems" />}
              />
            )}
            <LoadState
              query={query}
              what="the wiring"
              count={wirings.length}
              emptySlot={
                <EmptyState
                  iconSlot={<GitBranch />}
                  title="No wiring yet"
                  description="Servable concepts generate it. Wire a source by hand to rename its types and fields in the unified API."
                  actionSlot={<Button variant="outline" content="Go to Concepts" linkSlot={<Link to="/concepts" />} />}
                />
              }
            />
            {wirings.map((wiring) => (
              <SourceWiringCard
                key={wiring.source}
                wiring={wiring}
                problems={wiringProblems.filter((one) => one.source === wiring.source)}
                onEdit={() => openDialog(wiring)}
                onProblem={setProblem}
              />
            ))}
          </>
        }
      />
      {dialog === null ? null : (
        <WiringDialog
          key={dialog.session}
          open
          onOpenChange={(isOpen) => {
            if (isOpen === false) {
              setDialog(null);
            }
          }}
          wiring={dialog.wiring}
          sources={unwiredSources}
        />
      )}
    </>
  );
}

interface SourceWiringCardProps {
  wiring: SourceWiring;
  /** The wiring problems about this source. */
  problems: readonly UnifiedProblem[];
  onEdit: () => void;
  /** Told what went wrong when clearing the override fails. */
  onProblem: (problem: string) => void;
}

/** One source's wiring: a row per rename and merge key with where it came from, Edit, and Clear override. */
function SourceWiringCard({ wiring, problems, onEdit, onProblem }: SourceWiringCardProps) {
  const clearOverride = useClearWiringOverride();
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const rows = wiringRows(wiring);
  const hasOverride = wiring.override !== null;

  /** Drops the override, and says so when the server refuses. */
  const clear = (): void => {
    clearOverride.mutate(wiring.source, {
      onError: (error) => onProblem(`Couldn't clear ${wiring.source}'s override. ${messageOf(error) ?? ''}`.trim()),
    });
  };

  return (
    <>
      <CardLayout
        title={wiring.source}
        description={wiring.generated === null ? 'Wired by hand: no concept generates wiring for it.' : undefined}
        actionSlot={
          <>
            {hasOverride ? <Badge variant="warning-soft">Overridden</Badge> : null}
            {hasOverride ? (
              <Button
                size="sm"
                variant="outline"
                iconSlot={<Undo2 />}
                content="Clear override"
                loading={clearOverride.isPending}
                onClick={() => setIsConfirmingClear(true)}
              />
            ) : null}
            <Button size="sm" variant="outline" iconSlot={<Pencil />} content="Edit" onClick={onEdit} />
          </>
        }
        contentSlot={
          <div className="grid gap-4">
            {problems.length === 0 ? null : (
              <UnifiedProblemList problems={problems} label={`Wiring problems for ${wiring.source}`} />
            )}
            {rows.length === 0 ? (
              <EmptyState compact title="No renames or merge keys." />
            ) : (
              <WiringTable rows={rows} source={wiring.source} />
            )}
            {hasOverride ? (
              <Collapsible
                title="Stored override"
                contentSlot={
                  <CodeBlock content={JSON.stringify(wiring.override, null, 2)} language="json" maxHeight="md" />
                }
              />
            ) : null}
          </div>
        }
      />
      <ConfirmDialog
        open={isConfirmingClear}
        onOpenChange={setIsConfirmingClear}
        title={`Clear ${wiring.source}'s override?`}
        description="Every rename and merge key you set or removed goes back to what the concepts generate."
        confirmLabel="Clear override"
        onConfirm={clear}
      />
    </>
  );
}

interface WiringTableProps {
  rows: readonly WiringRow[];
  source: string;
}

/** A source's wiring entries as a table: kind, source name, unified name or lookup, and origin. */
function WiringTable({ rows, source }: WiringTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>In {source}</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Unified</TableHead>
          <TableHead>Origin</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const badge = ORIGIN_BADGES[row.origin];
          const isRemoved = row.origin === 'removed';
          return (
            <TableRow key={`${row.origin}:${row.id}`}>
              <TableHead className="font-mono font-normal">{row.from}</TableHead>
              <TableCell>{KIND_LABELS[row.kind]}</TableCell>
              <TableCell className={isRemoved ? 'font-mono text-foreground/60 line-through' : 'font-mono'}>
                {row.to}
                {row.generatedTo === null || isRemoved ? null : (
                  <span className="block font-sans text-foreground/60 text-xs">Generated: {row.generatedTo}</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
