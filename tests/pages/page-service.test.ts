import { HOME_SLUG, type PageService } from '../../server/core/services.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { modules, upstreams } from '../../server/db/schema.ts';
import { createPageService } from '../../server/pages/page-service.ts';
import { openTestDatabase } from '../db.ts';

let opened: OpenedDatabase;
let pages: PageService;
let moduleId = '';

beforeAll(async () => {
  opened = await openTestDatabase();
  pages = createPageService({ db: opened.db });
  const [upstream] = await opened.db
    .insert(upstreams)
    .values({ name: 'shop', url: 'http://x.test/graphql' })
    .returning();
  const [module] = await opened.db
    .insert(modules)
    .values({ name: 'Orders', upstreamId: upstream?.id ?? '', source: 'x', status: 'READY' })
    .returning();
  moduleId = module?.id ?? '';
});
afterAll(() => opened.close());

describe('pages', () => {
  it('always has Home first', async () => {
    await pages.add('Zebra');
    const all = await pages.list();
    expect(all[0]?.slug).toBe(HOME_SLUG);
    expect(all.map((page) => page.slug)).toContain('zebra');
  });

  it('makes unique slugs', async () => {
    const page = await pages.add('Zebra');
    expect(page.slug).toBe('zebra-2');
  });

  it('places, resizes, moves and removes items', async () => {
    await pages.addItem({ pageSlug: HOME_SLUG, moduleId });
    const page = await pages.addItem({ pageSlug: HOME_SLUG, moduleId, columnSpan: 1 });
    const [first, second] = page.items;
    expect(first?.columnSpan).toBe(2);
    const moved = await pages.moveItem(second?.id ?? '', -1);
    expect(moved.items.map((item) => item.id)).toEqual([second?.id, first?.id]);
    const resized = await pages.updateItem({ id: first?.id ?? '', columnSpan: 4, fullWidth: true });
    expect(resized.items[1]).toMatchObject({ columnSpan: 4, fullWidth: true });
    await expect(pages.updateItem({ id: first?.id ?? '', columnSpan: 99, fullWidth: false })).rejects.toThrow(
      /columns wide/,
    );
    const removed = await pages.removeItem(second?.id ?? '');
    expect(removed.items).toHaveLength(1);
  });

  it("won't delete Home", async () => {
    await expect(pages.remove(HOME_SLUG)).rejects.toThrow(/Home/);
    expect(await pages.remove('zebra')).toBe(true);
  });
});
