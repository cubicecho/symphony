// Which specifiers a module may import. web/src/modules builds the browser's shared-module registry with
// the same rule (import.meta.glob over web/src/components), so the two lists match.
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The specifiers every module may import, whatever components are installed. */
export const RUNTIME_IMPORTS = ['react', 'react/jsx-runtime', 'symphony', '@/lib/utils'] as const;

/** Where the installed cubeui components live: web/src/components. */
export const COMPONENTS_DIR = fileURLToPath(new URL('../../web/src/components', import.meta.url));

/** The prefix a component's specifier starts with. */
export const COMPONENT_PREFIX = '@/components/';

/** A source file a module may import as a component: `.ts` or `.tsx`. */
const SOURCE_FILE = /\.tsx?$/;

/** Tests and stories sit beside the components but are not shared with modules. */
const EXCLUDED_FILE = /\.(?:test|stories)\./;

/**
 * Lists every specifier a module may import.
 *
 * @param [componentsDir] - The components folder to scan.
 * @returns RUNTIME_IMPORTS plus `@/components/<path without extension>` for each component file.
 */
export async function loadAllowedImports(componentsDir: string = COMPONENTS_DIR): Promise<Set<string>> {
  const entries = await readdir(componentsDir, { recursive: true, withFileTypes: true });
  const allowed = new Set<string>(RUNTIME_IMPORTS);
  for (const entry of entries) {
    const isComponentFile = entry.isFile() && SOURCE_FILE.test(entry.name) && EXCLUDED_FILE.test(entry.name) === false;
    if (isComponentFile) {
      allowed.add(componentSpecifier(componentsDir, join(entry.parentPath, entry.name)));
    }
  }
  return allowed;
}

/**
 * Turns a component file's path into the specifier a module imports it by.
 *
 * @param componentsDir - The components folder the path is under.
 * @param filePath - The file's absolute path.
 * @returns `@/components/<relative path, forward slashes, no extension>`.
 */
function componentSpecifier(componentsDir: string, filePath: string): string {
  const path = relative(componentsDir, filePath).split(sep).join('/').replace(SOURCE_FILE, '');
  return `${COMPONENT_PREFIX}${path}`;
}
