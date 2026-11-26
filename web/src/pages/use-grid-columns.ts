import { type RefObject, useLayoutEffect, useState } from 'react';
import { columnsThatFit } from './column-span.ts';

/** Pixels in one rem when the root's font size can't be read. */
const FALLBACK_REM_PX = 16;

/**
 * Reads how many pixels one rem is.
 *
 * @returns The root element's font size.
 */
function remPx(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) ? size : FALLBACK_REM_PX;
}

/**
 * Follows how many columns a grid has room for, as its own width changes (the window, the sidebar).
 *
 * @param ref - The grid element.
 * @param maxColumns - The page's columns at full width.
 * @returns From 1 to `maxColumns`. Measured before the first paint, so the grid never draws at a wrong width.
 */
export function useGridColumns(ref: RefObject<HTMLElement | null>, maxColumns: number): number {
  const [columns, setColumns] = useState(1);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = (): void => setColumns(columnsThatFit(element.getBoundingClientRect().width, maxColumns, remPx()));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, maxColumns]);

  return columns;
}
