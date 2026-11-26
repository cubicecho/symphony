import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Badge } from '@/components/ui/badge';
import type { CompileError } from './use-modules.ts';

/** What each compile stage is called on an error's row. */
const STAGE_LABELS = {
  SOURCE: 'Source',
  IMPORTS: 'Imports',
  GRAPHQL: 'GraphQL',
  TRANSFORM: 'Transform',
} as const;

interface CompileErrorListProps {
  errors: readonly CompileError[];
  /** Moves the editor's caret to a place in the source. Lines and columns count from 1. */
  onJump: (line: number, column: number) => void;
}

/**
 * Names where an error is.
 *
 * @param error - The error.
 * @returns "12:5", "line 12", or null when it has no place.
 */
function placeOf(error: CompileError): string | null {
  if (error.line === null) {
    return null;
  }
  return error.column === null ? `line ${error.line}` : `${error.line}:${error.column}`;
}

/** The last save's compile errors, each with its stage and place; one with a place moves the caret to it. */
export function CompileErrorList({ errors, onJump }: CompileErrorListProps) {
  return (
    <List
      label="Compile errors"
      contentSlot={errors.map((error, index) => {
        const place = placeOf(error);
        const { line } = error;
        return (
          <ListItem
            // Errors have no id; the compiler reports them in source order.
            // biome-ignore lint/suspicious/noArrayIndexKey: errors are replaced whole on each save.
            key={index}
            title={<span className="font-mono text-sm">{error.message}</span>}
            leadingSlot={<Badge variant="destructive-soft">{STAGE_LABELS[error.stage]}</Badge>}
            meta={place === null ? undefined : place}
            onClick={line === null ? undefined : () => onJump(line, error.column ?? 1)}
          />
        );
      })}
    />
  );
}
