// Copies the cubeui skill docs and registry metadata into server/catalog, where the component catalog reads
// them. Run with `npm run catalog:sync` after installing or updating cubeui components; the output is committed.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RegistryFile, RegistryItem } from '../server/catalog/registry.ts';
import { errorMessage } from '../server/core/errors.ts';

/** The cubeui checkout read when `CUBEUI_DIR` is unset. */
const DEFAULT_CUBEUI_DIR = '/home/vantreeseba/nas_code/cubicecho/cubeui';

/** Where the synced data goes. */
const CATALOG_DIR = fileURLToPath(new URL('../server/catalog', import.meta.url));

/** Skill files that are only about React Native, which Symphony never uses. */
const NATIVE_ONLY = new Set(['native.md', 'forms/native.md']);

/** Skill folders that are not component documentation. */
const SKIPPED_FOLDERS = ['migrations/'];

/** A source file's extension, stripped from a registry file's name. */
const SOURCE_EXTENSION = /\.(?:tsx?|css)$/;

/** Spaces a JSON file is indented with, matching Biome's formatter. */
const JSON_INDENT = 2;

/** The parts of a registry.web.json item the sync reads. */
interface SourceItem {
  name: string;
  title?: string;
  description?: string;
  files?: { path: string }[];
}

/**
 * Says whether a skill file is copied.
 *
 * @param path - The file's path under skill/, with forward slashes.
 * @returns True for a Markdown file outside migrations/ that is not native-only.
 */
function isCopied(path: string): boolean {
  const isMarkdown = path.endsWith('.md');
  const isSkipped = NATIVE_ONLY.has(path) || SKIPPED_FOLDERS.some((folder) => path.startsWith(folder));
  return isMarkdown && isSkipped === false;
}

/**
 * Copies the skill's Markdown files into server/catalog/docs, replacing what was there.
 *
 * @param cubeuiDir - The cubeui checkout.
 * @returns The copied paths, relative to docs/.
 */
async function syncDocs(cubeuiDir: string): Promise<string[]> {
  const skillDir = join(cubeuiDir, 'skill');
  const docsDir = join(CATALOG_DIR, 'docs');
  await rm(docsDir, { recursive: true, force: true });
  const entries = await readdir(skillDir, { recursive: true, withFileTypes: true });
  const copied: string[] = [];
  for (const entry of entries) {
    const path = relative(skillDir, join(entry.parentPath, entry.name)).split(sep).join('/');
    const isWanted = entry.isFile() && isCopied(path);
    if (isWanted) {
      const target = join(docsDir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(skillDir, path), 'utf-8'));
      copied.push(path);
    }
  }
  return copied.sort();
}

/**
 * Reduces one registry item to what the catalog needs.
 *
 * @param item - The item as registry.web.json has it.
 * @returns Its name, title, description and the base names of its files.
 */
function toRegistryItem(item: SourceItem): RegistryItem {
  return {
    name: item.name,
    title: item.title ?? '',
    description: item.description ?? '',
    files: (item.files ?? []).map((file) => basename(file.path).replace(SOURCE_EXTENSION, '')),
  };
}

/**
 * Writes server/catalog/registry.json from cubeui's registry.web.json.
 *
 * @param cubeuiDir - The cubeui checkout.
 * @returns How many items were written.
 */
async function syncRegistry(cubeuiDir: string): Promise<number> {
  const raw: { items?: SourceItem[] } = JSON.parse(await readFile(join(cubeuiDir, 'registry.web.json'), 'utf-8'));
  const registry: RegistryFile = { items: (raw.items ?? []).map(toRegistryItem) };
  const text = `${JSON.stringify(registry, null, JSON_INDENT)}\n`;
  await writeFile(join(CATALOG_DIR, 'registry.json'), text);
  return registry.items.length;
}

/** Runs the sync and reports what it copied. */
async function main(): Promise<void> {
  const cubeuiDir = process.env.CUBEUI_DIR || DEFAULT_CUBEUI_DIR;
  const docs = await syncDocs(cubeuiDir);
  const items = await syncRegistry(cubeuiDir);
  console.log(`[catalog] synced ${docs.length} docs and ${items} registry items from ${cubeuiDir}`);
}

try {
  await main();
} catch (error) {
  console.error(`[catalog] sync failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
