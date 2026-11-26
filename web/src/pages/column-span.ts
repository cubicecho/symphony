import type { CSSProperties } from 'react';

// Plain functions with no app imports, so tests reach them without the web app's path aliases.
// A page is one grid. It has as many columns as Limits.columns says, or fewer when the page is too narrow
// for cards of MIN_CARD_WIDTH_REM, so a phone gets one column. An item takes the columns it was given,
// clamped to the columns there are, or the whole row when it is full width. The clamp is only drawn, never saved.

/** The narrowest a card may get before the grid drops a column, in rem. */
export const MIN_CARD_WIDTH_REM = 10;
/** A page narrower than this, in rem, is one column whatever fits: a phone reads cards one at a time. */
export const SINGLE_COLUMN_BELOW_REM = 30;
/** The space between cards, in rem: the grid's `gap-4`. */
export const GRID_GAP_REM = 1;

/** How wide an item is. The same two fields the API has. */
export interface ItemWidth {
  /** Columns it spans when not full width. */
  columnSpan: number;
  /** Whether it takes a row of its own. */
  fullWidth: boolean;
}

/** The width dialog's choice besides a number of columns. */
export const FULL_WIDTH_CHOICE = 'FULL' as const;

/**
 * Works out how many columns fit a grid of a given width.
 *
 * @param widthPx - The grid's width, in pixels.
 * @param maxColumns - The page's columns at full width.
 * @param remPx - Pixels in one rem.
 * @returns 1 under SINGLE_COLUMN_BELOW_REM; otherwise from 1 to `maxColumns`, as many cards of at least
 * MIN_CARD_WIDTH_REM as fit with their gaps.
 */
export function columnsThatFit(widthPx: number, maxColumns: number, remPx: number): number {
  const isNarrow = widthPx < SINGLE_COLUMN_BELOW_REM * remPx;
  if (isNarrow) {
    return 1;
  }
  const cardPx = MIN_CARD_WIDTH_REM * remPx;
  const gapPx = GRID_GAP_REM * remPx;
  const fitting = Math.floor((widthPx + gapPx) / (cardPx + gapPx));
  return Math.max(1, Math.min(maxColumns, fitting));
}

/**
 * Places an item in the grid.
 *
 * @param width - The item's width.
 * @param columns - The columns the grid has right now.
 * @returns The `grid-column` style: the whole row, or its span clamped to the columns there are.
 */
export function spanStyle(width: ItemWidth, columns: number): CSSProperties {
  if (width.fullWidth) {
    return { gridColumn: '1 / -1' };
  }
  const span = Math.min(width.columnSpan, columns);
  return { gridColumn: `span ${span} / span ${span}` };
}

/**
 * Names a number of columns.
 *
 * @param columns - How many.
 * @returns "1 column", "3 columns".
 */
export function columnsLabel(columns: number): string {
  return columns === 1 ? '1 column' : `${columns} columns`;
}

/**
 * Names a width as the menus and dialogs say it.
 *
 * @param width - The width.
 * @returns "Full width" or a number of columns.
 */
export function widthLabel(width: ItemWidth): string {
  return width.fullWidth ? 'Full width' : columnsLabel(width.columnSpan);
}

/**
 * Picks the width select's choice for a width.
 *
 * @param width - The item's width.
 * @returns FULL, or the number of columns as text.
 */
export function widthChoiceOf(width: ItemWidth): string {
  return width.fullWidth ? FULL_WIDTH_CHOICE : String(width.columnSpan);
}

/**
 * Turns the width select's choice into what the API takes.
 *
 * @param choice - FULL, or a number of columns as text.
 * @param fallbackColumns - The span kept for a full-width item, so turning full width off again restores something sensible.
 * @returns The width.
 */
export function widthFromChoice(choice: string, fallbackColumns: number): ItemWidth {
  if (choice === FULL_WIDTH_CHOICE) {
    return { columnSpan: fallbackColumns, fullWidth: true };
  }
  return { columnSpan: Number(choice), fullWidth: false };
}

/**
 * Lists the width select's choices: 1 to `maxColumns`, then full width.
 *
 * @param maxColumns - The widest an item may be set to.
 * @returns The options.
 */
export function widthOptions(maxColumns: number): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (let span = 1; span <= maxColumns; span += 1) {
    options.push({ value: String(span), label: columnsLabel(span) });
  }
  options.push({ value: FULL_WIDTH_CHOICE, label: 'Full width' });
  return options;
}
