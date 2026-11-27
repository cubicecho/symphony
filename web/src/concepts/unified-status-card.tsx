import { CardLayout } from '@/components/card-layout';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { RefreshCw } from '@/components/ui/icons';
import { ExternalLink } from '@/core/app-icons';
import { countLabel, formatDateTime } from '@/core/format';
import { placeOf } from './concept-summary.ts';
import { type UnifiedStatus, useUnifiedStatus } from './use-concepts.ts';

/** A badge's colour, by name. */
type BadgeVariant = 'positive-soft' | 'warning-soft' | 'destructive-soft' | 'info-soft';

/** What each state says. The words carry the meaning; the colour repeats it. */
const STATE_BADGES: Readonly<Record<string, { label: string; variant: BadgeVariant }>> = {
  STARTING: { label: 'Starting', variant: 'info-soft' },
  READY: { label: 'Serving', variant: 'positive-soft' },
  FAILED: { label: 'Not serving', variant: 'destructive-soft' },
};

/** What each kind of problem is called on its row. */
const PROBLEM_KINDS: Readonly<Record<string, string>> = {
  CONCEPT: 'Concept',
  WIRING: 'Wiring',
  SOURCE: 'Source',
};

/** One problem with the unified API. */
export type UnifiedProblem = UnifiedStatus['problems'][number];

interface UnifiedStateBadgeProps {
  /** The state as the API sends it; a state this app does not know is shown as sent. */
  state: string;
}

/** The unified API's state as a soft badge. */
export function UnifiedStateBadge({ state }: UnifiedStateBadgeProps) {
  const badge = STATE_BADGES[state];
  return badge === undefined ? <Badge>{state}</Badge> : <Badge variant={badge.variant}>{badge.label}</Badge>;
}

interface UnifiedProblemListProps {
  problems: readonly UnifiedProblem[];
  /** What the list is, for a screen reader. */
  label: string;
}

/** Problems with the unified API, each with its kind, where it is and what it says. */
export function UnifiedProblemList({ problems, label }: UnifiedProblemListProps) {
  return (
    <List
      label={label}
      contentSlot={problems.map((problem, index) => {
        const where = [problem.source, problem.concept === null ? null : `concept ${problem.concept}`]
          .filter((part) => part !== null)
          .join(' · ');
        const place = placeOf({
          member: null,
          operation: problem.operation,
          line: problem.line,
          column: problem.column,
        });
        return (
          <ListItem
            // Problems have no id; the server lists them in the order it found them.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole on each fetch.
            key={index}
            leadingSlot={<Badge variant="warning-soft">{PROBLEM_KINDS[problem.kind] ?? problem.kind}</Badge>}
            title={<span className="text-sm">{problem.message}</span>}
            description={where === '' ? undefined : where}
            meta={place ?? undefined}
          />
        );
      })}
    />
  );
}

interface CompositionErrorProps {
  error: NonNullable<UnifiedStatus['lastError']>;
  /** Whether a supergraph is still served from an earlier composition. */
  isServing: boolean;
}

/** The last failed composition, with each issue the composer named. */
function CompositionError({ error, isServing }: CompositionErrorProps) {
  return (
    <Alert
      variant={isServing ? 'warning' : 'destructive'}
      title={`The last composition failed, ${formatDateTime(error.at)}`}
      description={
        <>
          <span className="block">
            {isServing ? 'The unified API keeps serving what it composed before. ' : ''}
            {error.message}
          </span>
          {error.issues.length === 0 ? null : (
            <ul className="mt-2 list-disc ps-5">
              {error.issues.map((issue, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: issues have no id and are replaced whole.
                <li key={index}>
                  <span className="font-mono text-xs">{issue.code}</span>
                  {issue.source === null ? '' : ` in ${issue.source}`}: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </>
      }
    />
  );
}

/**
 * The unified API at a glance: whether it is serving, where, which sources it is composed from, what was left out
 * and the last failure.
 */
export function UnifiedStatusCard() {
  const query = useUnifiedStatus();
  const status = query.data;
  const endpointUrl = status === undefined ? '' : new URL(status.endpoint, window.location.origin).toString();

  return (
    <CardLayout
      title="Unified API"
      description="Every upstream and the servable concepts, composed into one GraphQL endpoint."
      actionSlot={
        <>
          {status === undefined ? null : <UnifiedStateBadge state={status.state} />}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh the unified API's status"
            iconSlot={<RefreshCw />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          />
        </>
      }
      contentSlot={
        status === undefined ? (
          <LoadState query={query} what="the unified API's status" record={status} notFoundLabel="No status" />
        ) : (
          <div className="grid gap-4">
            <PropertyList
              contentSlot={[
                <PropertyRow
                  key="endpoint"
                  label="Endpoint"
                  value={
                    <a
                      href={status.endpoint}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 break-all font-mono text-sm underline"
                    >
                      {status.endpoint}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  }
                  actionSlot={<CopyButton value={endpointUrl} label="Copy the endpoint" />}
                />,
                <PropertyRow
                  key="composed"
                  label="Composed"
                  value={status.composedAt === null ? 'Not yet' : formatDateTime(status.composedAt)}
                />,
                <PropertyRow
                  key="sources"
                  label="Sources"
                  value={
                    status.sources.length === 0 ? (
                      'None'
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {status.sources.map((source) => (
                          <Badge key={source.name} variant={source.kind === 'schema' ? 'info-soft' : undefined}>
                            {source.name}
                          </Badge>
                        ))}
                      </span>
                    )
                  }
                  hint={countLabel(status.sources.length, 'source', 'sources')}
                />,
              ]}
            />
            {status.lastError === null ? null : (
              <CompositionError error={status.lastError} isServing={status.state === 'READY'} />
            )}
            {status.problems.length === 0 ? null : (
              <Section
                level={3}
                title={`Left out (${status.problems.length})`}
                description="What the last composition could not include. Fix it, and the next save composes it in."
                contentSlot={<UnifiedProblemList problems={status.problems} label="Problems with the unified API" />}
              />
            )}
          </div>
        )
      }
    />
  );
}
