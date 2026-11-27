import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { type ConceptProblem, placeOf } from './concept-summary.ts';

interface ConceptProblemListProps {
  problems: readonly ConceptProblem[];
  /** What the list is, for a screen reader. */
  label: string;
  /** Leave out the member and document in each place, when the list already sits under them. */
  placed?: boolean | undefined;
}

/** A concept's problems, each with where it is: the member, the document, and the line in it. */
export function ConceptProblemList({ problems, label, placed = false }: ConceptProblemListProps) {
  return (
    <List
      label={label}
      contentSlot={problems.map((problem, index) => {
        const place = placed ? placeOf({ ...problem, member: null, operation: null }) : placeOf(problem);
        return (
          <ListItem
            // Problems have no id; the server reports them in the order it checks.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole on each check.
            key={index}
            title={<span className="font-mono text-sm">{problem.message}</span>}
            meta={place ?? undefined}
          />
        );
      })}
    />
  );
}
