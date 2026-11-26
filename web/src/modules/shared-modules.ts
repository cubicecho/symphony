// What a module's `require` resolves. The server's import allowlist (server/modules/allowlist.ts) is
// built by the same rule: every .ts/.tsx under web/src/components, tests and stories left out, keyed
// as `@/components/<path without extension>`. Change one and the other must change with it.
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as utils from '@/lib/utils';
import * as runtime from './runtime.ts';

/** The prefix a component's specifier starts with. */
const COMPONENT_PREFIX = '@/components/';

/** Every installed component file, loaded with the app (fine while there are a few dozen). */
const COMPONENT_FILES: Record<string, unknown> = import.meta.glob(
  ['../components/**/*.{ts,tsx}', '!../components/**/*.test.*', '!../components/**/*.stories.*'],
  { eager: true },
);

/**
 * Turns a glob key into the specifier a module imports the file by.
 *
 * @param path - `../components/ui/button.tsx`.
 * @returns `@/components/ui/button`.
 */
function specifierOf(path: string): string {
  return `${COMPONENT_PREFIX}${path.replace('../components/', '').replace(/\.tsx?$/, '')}`;
}

/** Every specifier module code may `require`, and what it gets. */
export const SHARED_MODULES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['react', React],
  ['react/jsx-runtime', jsxRuntime],
  ['symphony', runtime],
  ['@/lib/utils', utils],
  ...Object.entries(COMPONENT_FILES).map(([path, exports]): [string, unknown] => [specifierOf(path), exports]),
]);
