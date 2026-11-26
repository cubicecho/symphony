import { useRef } from 'react';
import { ModuleCard } from '@/modules/module-card';
import { spanStyle } from './column-span.ts';
import { ItemMenu } from './item-menu.tsx';
import { useGridColumns } from './use-grid-columns.ts';
import { type Page, useLimits } from './use-pages.ts';

interface PageGridProps {
  /** A page with at least one item. */
  page: Page;
  /** Whether each item shows its name and its menu above it. */
  isEditing: boolean;
  /** Told what went wrong when the server refuses an item's action. */
  onProblem: (problem: string) => void;
}

/** A page's items in one grid, each its chosen width, each a live module. */
export function PageGrid({ page, isEditing, onProblem }: PageGridProps) {
  const gridRef = useRef<HTMLUListElement>(null);
  const limits = useLimits().data;
  const columns = useGridColumns(gridRef, limits?.columns ?? 1);

  return (
    <ul
      ref={gridRef}
      aria-label={`${page.title} modules`}
      // items-start: a short module keeps its own height beside a tall one instead of stretching to the row's.
      className="grid w-full items-start gap-4"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {page.items.map((item, index) => (
        <li key={item.id} className="flex min-w-0 flex-col gap-2" style={spanStyle(item, columns)}>
          {isEditing ? (
            <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-foreground/10 border-dashed px-2 py-1">
              <span className="truncate text-foreground/60 text-sm">{item.module.name}</span>
              <ItemMenu page={page} item={item} index={index} onProblem={onProblem} />
            </div>
          ) : null}
          <ModuleCard module={item.module} />
        </li>
      ))}
    </ul>
  );
}
