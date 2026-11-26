// Reads the value names a component file exports, without parsing TypeScript: cubeui files only use the
// three plain forms below.

/** `export function X`, `export async function X`, `export const X`, `export class X`. */
const DECLARED_EXPORT = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/** `export { A, B as C }`, possibly over several lines. `export type { … }` is matched too and then skipped. */
const LIST_EXPORT = /^export\s+(type\s+)?\{([^}]*)\}/gm;

/** One entry of an export list: an optional `type`, the local name, and an optional `as` name. */
const LIST_ENTRY = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;

/**
 * Reads the names one entry of an `export { … }` list makes public.
 *
 * @param entry - The entry's text, trimmed.
 * @returns The exported name, or null for a type-only entry or one that is not a name.
 */
function listEntryName(entry: string): string | null {
  const match = LIST_ENTRY.exec(entry);
  if (match === null) {
    return null;
  }
  const [, typeOnly, local, alias] = match;
  if (typeOnly !== undefined) {
    return null;
  }
  return alias ?? local ?? null;
}

/**
 * Lists the value names a source file exports. Types and interfaces are left out.
 *
 * @param source - The file's text.
 * @returns The names, declarations before export lists, each once.
 */
export function parseExports(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(DECLARED_EXPORT)) {
    const [, name] = match;
    if (name !== undefined) {
      names.add(name);
    }
  }
  for (const match of source.matchAll(LIST_EXPORT)) {
    const [, typeOnly, list] = match;
    const isValueList = typeOnly === undefined && list !== undefined;
    if (isValueList) {
      for (const entry of list.split(',')) {
        const name = listEntryName(entry.trim());
        if (name !== null) {
          names.add(name);
        }
      }
    }
  }
  return [...names];
}
