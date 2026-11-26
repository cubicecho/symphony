/**
 * Writes an ISO 8601 time as the reader's locale writes a date and time.
 *
 * @param iso - The time, as the API sends it.
 * @returns "25 Nov 2026, 18:27", or the text unchanged when it is not a date.
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const isInvalid = Number.isNaN(date.getTime());
  if (isInvalid) {
    return iso;
  }
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Names a count of something.
 *
 * @param count - How many.
 * @param one - The word for one.
 * @param many - The word for several.
 * @returns "1 type", "12 types".
 */
export function countLabel(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}
