// The registry metadata scripts/sync-catalog.ts copies from cubeui's registry.web.json.
import { readFile } from 'node:fs/promises';

/** One cubeui registry item, reduced to what the catalog reads. */
export interface RegistryItem {
  /** The item's registry name, `card-layout`. */
  name: string;
  title: string;
  /** One line on what it is for. */
  description: string;
  /** The base names of the files it installs, without extension: `copy-button-base`, `copy-button`. */
  files: string[];
}

/** The shape of server/catalog/registry.json. */
export interface RegistryFile {
  items: RegistryItem[];
}

/**
 * Reads the synced registry.
 *
 * @param path - The registry.json file.
 * @returns Its items, or none when the file is missing (the sync has not run).
 */
export async function readRegistry(path: string): Promise<RegistryItem[]> {
  try {
    const file: Partial<RegistryFile> = JSON.parse(await readFile(path, 'utf-8'));
    return file.items ?? [];
  } catch {
    return [];
  }
}

/**
 * Finds the registry item a component file belongs to.
 *
 * @param items - The registry.
 * @param fileName - The file's base name without extension, `card-layout`.
 * @returns The item named after the file, else the item that installs it, else null.
 */
export function itemForFile(items: RegistryItem[], fileName: string): RegistryItem | null {
  const named = items.find((item) => item.name === fileName);
  if (named !== undefined) {
    return named;
  }
  return items.find((item) => item.files.includes(fileName)) ?? null;
}
