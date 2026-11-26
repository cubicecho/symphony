// The pages and the modules placed on them. Items keep their place as an integer that is renumbered
// on every move, so places stay 0..n-1 with no gaps.
import { asc, eq } from 'drizzle-orm';
import { UUID_PATTERN } from '../core/consts.ts';
import { LAYOUT_DEFAULTS, type LayoutSettings } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { HOME_SLUG, type Page, type PageService } from '../core/services.ts';
import type { Database } from '../db/client.ts';
import { items, modules, pages } from '../db/schema.ts';

const HOME_TITLE = 'Home';
const MAX_TITLE_CHARS = 60;
/** The two directions an item moves in. */
const MOVE_OFFSETS = [-1, 1];

type ItemRow = typeof items.$inferSelect;

/**
 * Makes a slug from a title.
 *
 * @param title - The page's title.
 * @returns Lower-case words joined by dashes, or `page` when nothing is left.
 */
function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'page' : slug;
}

/**
 * Builds the page service.
 *
 * @param deps - The database.
 * @param [overrides] - Layout settings to replace.
 * @returns The service.
 */
export function createPageService(deps: { db: Database }, overrides: Partial<LayoutSettings> = {}): PageService {
  const settings = { ...LAYOUT_DEFAULTS, ...overrides };
  const { db } = deps;

  /** Makes sure Home exists. Runs before every read, so a fresh database needs no seeding step. */
  const ensureHome = async (): Promise<void> => {
    await db.insert(pages).values({ slug: HOME_SLUG, title: HOME_TITLE, position: 0 }).onConflictDoNothing();
  };

  /**
   * Reads one page with its items.
   *
   * @param slug - The page.
   * @returns The page, or null.
   */
  const readPage = async (slug: string): Promise<Page | null> => {
    await ensureHome();
    const [row] = await db.select().from(pages).where(eq(pages.slug, slug));
    if (row === undefined) {
      return null;
    }
    const rows = await db.select().from(items).where(eq(items.pageSlug, slug)).orderBy(asc(items.position));
    return {
      slug: row.slug,
      title: row.title,
      items: rows.map((item) => ({
        id: item.id,
        moduleId: item.moduleId,
        columnSpan: item.columnSpan,
        fullWidth: item.fullWidth,
      })),
    };
  };

  /**
   * Reads a page that must exist.
   *
   * @param slug - The page.
   * @returns The page.
   * @throws NOT_FOUND.
   */
  const requirePage = async (slug: string): Promise<Page> => {
    const page = await readPage(slug);
    if (page === null) {
      throw notFound(`There is no page "${slug}".`);
    }
    return page;
  };

  /**
   * Reads an item that must exist.
   *
   * @param id - The item.
   * @returns Its row.
   * @throws NOT_FOUND.
   */
  const requireItem = async (id: string): Promise<ItemRow> => {
    const isId = UUID_PATTERN.test(id);
    const [row] = isId ? await db.select().from(items).where(eq(items.id, id)) : [];
    if (row === undefined) {
      throw notFound(`There is no item ${id}.`);
    }
    return row;
  };

  /**
   * Checks a width.
   *
   * @param columnSpan - Columns asked for.
   * @returns The same.
   * @throws BAD_USER_INPUT when it is outside 1..maxColumns.
   */
  const checkSpan = (columnSpan: number): number => {
    const isValid = Number.isInteger(columnSpan) && columnSpan >= 1 && columnSpan <= settings.maxColumns;
    if (isValid === false) {
      throw badInput(`An item is 1 to ${settings.maxColumns} columns wide.`);
    }
    return columnSpan;
  };

  /**
   * Writes a page's items back in a new order, numbering them from 0.
   *
   * @param ordered - The item ids in their new order.
   */
  const renumber = async (ordered: readonly string[]): Promise<void> => {
    await db.transaction(async (tx) => {
      for (const [position, id] of ordered.entries()) {
        await tx.update(items).set({ position }).where(eq(items.id, id));
      }
    });
  };

  return {
    list: async () => {
      await ensureHome();
      const rows = await db.select().from(pages).orderBy(asc(pages.position), asc(pages.title));
      const all = await Promise.all(rows.map((row) => requirePage(row.slug)));
      return all.sort((a, b) => Number(b.slug === HOME_SLUG) - Number(a.slug === HOME_SLUG));
    },

    find: readPage,

    add: async (title) => {
      const clean = title.trim();
      const isValid = clean !== '' && clean.length <= MAX_TITLE_CHARS;
      if (isValid === false) {
        throw badInput(`A page's title is 1–${MAX_TITLE_CHARS} characters.`);
      }
      await ensureHome();
      const existing = await db.select({ slug: pages.slug }).from(pages);
      const taken = new Set(existing.map((row) => row.slug));
      const base = slugOf(clean);
      let slug = base;
      for (let suffix = 2; taken.has(slug); suffix++) {
        slug = `${base}-${suffix}`;
      }
      await db.insert(pages).values({ slug, title: clean, position: existing.length });
      return requirePage(slug);
    },

    remove: async (slug) => {
      if (slug === HOME_SLUG) {
        throw badInput("Home can't be deleted.");
      }
      const deleted = await db.delete(pages).where(eq(pages.slug, slug)).returning();
      return deleted.length > 0;
    },

    addItem: async (input) => {
      const page = await requirePage(input.pageSlug);
      const isModuleId = UUID_PATTERN.test(input.moduleId);
      const [module] = isModuleId ? await db.select().from(modules).where(eq(modules.id, input.moduleId)) : [];
      if (module === undefined) {
        throw notFound(`There is no module ${input.moduleId}.`);
      }
      await db.insert(items).values({
        pageSlug: page.slug,
        moduleId: module.id,
        position: page.items.length,
        columnSpan: checkSpan(input.columnSpan ?? settings.newItemColumns),
        fullWidth: input.fullWidth ?? false,
      });
      return requirePage(page.slug);
    },

    updateItem: async (input) => {
      const row = await requireItem(input.id);
      await db
        .update(items)
        .set({ columnSpan: checkSpan(input.columnSpan), fullWidth: input.fullWidth })
        .where(eq(items.id, row.id));
      return requirePage(row.pageSlug);
    },

    moveItem: async (id, offset) => {
      if (MOVE_OFFSETS.includes(offset) === false) {
        throw badInput('An item moves one place at a time: offset is -1 or 1.');
      }
      const row = await requireItem(id);
      const page = await requirePage(row.pageSlug);
      const ids = page.items.map((item) => item.id);
      const from = ids.indexOf(row.id);
      const to = from + offset;
      const isInside = to >= 0 && to < ids.length;
      if (isInside) {
        [ids[from], ids[to]] = [ids[to] ?? row.id, row.id];
        await renumber(ids);
      }
      return requirePage(row.pageSlug);
    },

    removeItem: async (id) => {
      const row = await requireItem(id);
      await db.delete(items).where(eq(items.id, row.id));
      const page = await requirePage(row.pageSlug);
      await renumber(page.items.map((item) => item.id));
      return requirePage(row.pageSlug);
    },
  };
}
