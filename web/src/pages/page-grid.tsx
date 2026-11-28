import { useSearch } from '@tanstack/react-router';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Maximize2 } from '@/core/app-icons';
import { ModuleCard } from '@/modules/module-card';
import { spanStyle } from './column-span.ts';
import { fullPageLinkOf } from './full-page-link.tsx';
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

/**
 * The full-page button over an item outside edit mode: in its top corner, shown on hover or focus where there is
 * hover, and always on a touch screen.
 */
const FULL_PAGE_BUTTON_CLASS =
  'absolute top-2 right-2 z-10 motion-safe:transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100';

/** A page's items in one grid, each its chosen width, each a live module. */
export function PageGrid({ page, isEditing, onProblem }: PageGridProps) {
  const gridRef = useRef<HTMLUListElement>(null);
  // Each module's path, which "Open full page" opens it at.
  const search: Record<string, unknown> = useSearch({ strict: false });
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
        <li key={item.id} className="group relative flex min-w-0 flex-col gap-2" style={spanStyle(item, columns)}>
          {isEditing ? (
            <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-foreground/10 border-dashed px-2 py-1">
              <span className="truncate text-foreground/60 text-sm">{item.module.name}</span>
              <ItemMenu page={page} item={item} index={index} onProblem={onProblem} />
            </div>
          ) : (
            <Button
              variant="outline"
              size="icon-xs"
              aria-label={`Open ${item.module.name} full page`}
              hint="Open full page"
              className={FULL_PAGE_BUTTON_CLASS}
              iconSlot={<Maximize2 />}
              linkSlot={fullPageLinkOf(page.slug, item.id, search)}
            />
          )}
          <ModuleCard module={item.module} itemId={item.id} />
        </li>
      ))}
    </ul>
  );
}
