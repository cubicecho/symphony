// The cubeui components a module may import, read from web/src/components, with their documentation from the
// skill docs scripts/sync-catalog.ts copies into server/catalog/docs.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogComponent, ComponentCatalog } from '../core/services.ts';
import { COMPONENT_PREFIX, COMPONENTS_DIR } from '../modules/allowlist.ts';
import { parseExports } from './exports.ts';
import { type DocFile, type DocSection, splitSections, stripFrontMatter } from './markdown.ts';
import { itemForFile, readRegistry } from './registry.ts';

/** Where the synced skill docs live. */
const DOCS_DIR = fileURLToPath(new URL('./docs', import.meta.url));

/** The synced registry metadata. */
const REGISTRY_FILE = fileURLToPath(new URL('./registry.json', import.meta.url));

/** A component source file: `.ts` or `.tsx`. */
const SOURCE_FILE = /\.tsx?$/;

/** Files beside the components that are not components: tests, stories, and `*-base.ts` internals. */
const EXCLUDED_FILE = /\.(?:test|stories)\.|-base\.ts$/;

/** The doc names that are topics rather than components. */
const Topic = {
  Vocabulary: 'vocabulary',
  Index: 'index',
} as const;

/** The overview doc an `index` answer starts from. */
const OVERVIEW_DOC = 'SKILL.md';

/** The doc the `vocabulary` topic answers with. */
const VOCABULARY_DOC = 'vocabulary.md';

/** Most sections a component with no props table of its own is answered with, so a common word stays cheap. */
const MAX_FALLBACK_SECTIONS = 3;

/** What the catalog reads. */
export interface ComponentCatalogOptions {
  /**
   * The installed components.
   *
   * @defaultValue `COMPONENTS_DIR`
   */
  componentsDir?: string;
  /**
   * The synced skill docs.
   *
   * @defaultValue `server/catalog/docs`
   */
  docsDir?: string;
  /**
   * The synced registry metadata.
   *
   * @defaultValue `server/catalog/registry.json`
   */
  registryFile?: string;
}

/** Everything the catalog loads once. */
interface CatalogData {
  components: CatalogComponent[];
  docs: DocFile[];
  sections: DocSection[];
  /** Registry name of each component, by import path. Absent when the registry has no item for it. */
  registryNames: Map<string, string>;
  /** Registry title of each component, by import path. */
  titles: Map<string, string>;
}

/**
 * Turns a component file's path into the specifier a module imports it by (the allowlist's rule).
 *
 * @param componentsDir - The components folder the path is under.
 * @param filePath - The file's absolute path.
 * @returns `@/components/<relative path, forward slashes, no extension>`.
 */
function importPathOf(componentsDir: string, filePath: string): string {
  const path = relative(componentsDir, filePath).split(sep).join('/').replace(SOURCE_FILE, '');
  return `${COMPONENT_PREFIX}${path}`;
}

/**
 * Lists every file under a folder, recursively.
 *
 * @param dir - The folder.
 * @returns Absolute paths, sorted. None when the folder is missing.
 */
async function filesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Reads the components, the docs and the registry.
 *
 * @param componentsDir - The installed components.
 * @param docsDir - The synced docs.
 * @param registryFile - The synced registry.
 * @returns The loaded catalog.
 */
async function loadCatalog(componentsDir: string, docsDir: string, registryFile: string): Promise<CatalogData> {
  const registry = await readRegistry(registryFile);
  const sourceFiles = (await filesUnder(componentsDir)).filter((path) => {
    const name = basename(path);
    return SOURCE_FILE.test(name) && EXCLUDED_FILE.test(name) === false;
  });
  const components: CatalogComponent[] = [];
  const registryNames = new Map<string, string>();
  const titles = new Map<string, string>();
  for (const path of sourceFiles) {
    const importPath = importPathOf(componentsDir, path);
    const item = itemForFile(registry, basename(path).replace(SOURCE_FILE, ''));
    const exports = parseExports(await readFile(path, 'utf-8'));
    components.push({ importPath, exports, description: item?.description ?? '' });
    if (item !== null) {
      registryNames.set(importPath, item.name);
      titles.set(importPath, item.title);
    }
  }
  const docs: DocFile[] = [];
  for (const path of await filesUnder(docsDir)) {
    const isMarkdown = path.endsWith('.md');
    if (isMarkdown) {
      docs.push({ path: relative(docsDir, path).split(sep).join('/'), text: await readFile(path, 'utf-8') });
    }
  }
  const sections = docs.flatMap(splitSections);
  return { components, docs, sections, registryNames, titles };
}

/**
 * Finds the component a name refers to.
 *
 * @param data - The catalog.
 * @param name - An export name, an import path, a registry name or a file name, in any case.
 * @returns The component, or null.
 */
function findComponent(data: CatalogData, name: string): CatalogComponent | null {
  const wanted = name.trim();
  const lower = wanted.toLowerCase();
  const byExport =
    data.components.find((component) => component.exports.includes(wanted)) ??
    data.components.find((component) => component.exports.some((one) => one.toLowerCase() === lower));
  if (byExport !== undefined) {
    return byExport;
  }
  const matches = (component: CatalogComponent): boolean => {
    const fileName = component.importPath.slice(component.importPath.lastIndexOf('/') + 1);
    const candidates = [component.importPath, data.registryNames.get(component.importPath), fileName];
    return candidates.some((candidate) => candidate?.toLowerCase() === lower);
  };
  // A file named after its item (`card-layout.tsx`) wins over one that only ships with it (`copy-button-view.tsx`).
  const isPrimary = (component: CatalogComponent): boolean => component.importPath.endsWith(`/${lower}`);
  const found = data.components.filter(matches);
  return found.find(isPrimary) ?? found[0] ?? null;
}

/**
 * Picks the doc sections that cover a component.
 *
 * @param data - The catalog.
 * @param component - The component.
 * @returns The sections with its props tables; failing that, the few whose heading or examples name it.
 */
function sectionsFor(data: CatalogData, component: CatalogComponent): DocSection[] {
  const withProps = data.sections.filter((section) => section.props.some((name) => component.exports.includes(name)));
  if (withProps.length > 0) {
    return withProps;
  }
  const title = (data.titles.get(component.importPath) ?? '').toLowerCase();
  const isNamedInHeading = (section: DocSection): boolean => {
    const heading = section.heading.toLowerCase();
    const hasTitle = title !== '' && heading.includes(title);
    return hasTitle || component.exports.some((name) => heading.includes(name.toLowerCase()));
  };
  const isUsedInExample = (section: DocSection): boolean =>
    component.exports.some((name) => section.text.includes(`<${name}`));
  // The deepest sections are the most specific, so they are tried first.
  const bySpecificity = [...data.sections].sort((a, b) => b.level - a.level);
  const named = bySpecificity.filter(isNamedInHeading);
  const picked = named.length > 0 ? named : bySpecificity.filter(isUsedInExample);
  return picked.slice(0, MAX_FALLBACK_SECTIONS);
}

/**
 * Drops sections that sit inside another picked section, so no text is repeated.
 *
 * @param sections - Picked sections.
 * @returns The outermost ones, in their original order.
 */
function outermost(sections: DocSection[]): DocSection[] {
  return sections.filter(
    (section) =>
      sections.some(
        (other) => other !== section && other.file === section.file && other.text.includes(section.text),
      ) === false,
  );
}

/**
 * Writes the documentation answer for one component.
 *
 * @param data - The catalog.
 * @param component - The component.
 * @returns Its import line and description, then the doc sections that cover it.
 */
function componentDocs(data: CatalogData, component: CatalogComponent): string {
  const header = [
    `import { ${component.exports.join(', ')} } from '${component.importPath}';`,
    component.description,
  ].filter((line) => line !== '');
  const sections = outermost(sectionsFor(data, component));
  if (sections.length === 0) {
    header.push('', 'No skill doc covers this component. `get_component_docs` with `index` gives the overview.');
    return header.join('\n');
  }
  const bodies = sections.map((section) => `<!-- from ${section.file} -->\n${section.text}`);
  return [...header, '', ...bodies].join('\n\n');
}

/**
 * Writes the overview answer: the skill's front page and the topics `get_component_docs` takes.
 *
 * @param data - The catalog.
 * @returns Markdown.
 */
function indexDocs(data: CatalogData): string {
  const overview = data.docs.find((doc) => doc.path === OVERVIEW_DOC);
  const topics = data.docs
    .map((doc) => doc.path.replace(/\.md$/, ''))
    .filter((topic) => `${topic}.md` !== OVERVIEW_DOC)
    .map((topic) => `- \`${topic}\``);
  return [
    stripFrontMatter(overview?.text ?? ''),
    '## Topics',
    'Each of these is also a name `get_component_docs` takes, and answers with the whole doc:',
    ...topics,
  ].join('\n\n');
}

/**
 * Builds the component catalog over the installed components and the synced docs.
 *
 * @param [options] - Where it reads from.
 * @returns The catalog. It reads the files on first use and keeps them.
 *
 * @remarks
 * `*-base.ts` files are left out of `list()`: they hold the shared types, classes and hooks a component's
 * `.tsx` file builds on, and the `.tsx` file is what a module imports.
 */
export function createComponentCatalog(options: ComponentCatalogOptions = {}): ComponentCatalog {
  const { componentsDir = COMPONENTS_DIR, docsDir = DOCS_DIR, registryFile = REGISTRY_FILE } = options;
  let loading: Promise<CatalogData> | null = null;
  const load = (): Promise<CatalogData> => {
    loading ??= loadCatalog(componentsDir, docsDir, registryFile);
    return loading;
  };
  return {
    async list() {
      return (await load()).components;
    },
    async docs(name) {
      const data = await load();
      const wanted = name.trim().toLowerCase();
      if (wanted === Topic.Index) {
        return indexDocs(data);
      }
      if (wanted === Topic.Vocabulary) {
        return stripFrontMatter(data.docs.find((doc) => doc.path === VOCABULARY_DOC)?.text ?? '') || null;
      }
      const component = findComponent(data, name);
      if (component !== null) {
        return componentDocs(data, component);
      }
      const doc = data.docs.find((one) => one.path.toLowerCase() === `${wanted.replace(/\.md$/, '')}.md`);
      return doc === undefined ? null : stripFrontMatter(doc.text);
    },
  };
}
