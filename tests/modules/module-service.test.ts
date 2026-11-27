// The module service over several upstreams: their order is kept, each document is checked against its own
// upstream, and a re-check of any one of them reaches every module that lists it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../server/core/errors.ts';
import { type ModuleService, ModuleStatus, type Upstream, type UpstreamService } from '../../server/core/services.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { RUNTIME_IMPORTS } from '../../server/modules/allowlist.ts';
import { createModuleService } from '../../server/modules/module-service.ts';
import { openTestDatabase } from '../db.ts';
import { cachedUpstream, MEMO_SDL, MEMO_SDL_WITHOUT_RETITLE } from '../fixtures/memo-upstream.ts';
import { FIXTURE_SDL } from '../fixtures/upstream.ts';

/** A module reading the shop by default and retitling a memo through `gql.from`. */
const SOURCE = `import { gql, useMutation, useQuery } from 'symphony';

const ORDERS = gql\`query Orders { orders(first: 1) { id } }\`;
const RETITLE = gql.from('memos')\`mutation Retitle { retitleMemo(id: "m1", title: "x") { id } }\`;

export default function Both() {
  useQuery(ORDERS);
  useMutation(RETITLE);
  return null;
}
`;

/** The upstreams' ids: UUIDs, as the column holds. */
const SHOP_ID = '5a1f0c2d-6b3e-4c7f-8a90-b1c2d3e4f5a6';
const MEMOS_ID = '6b2a1d3e-7c4f-4d80-9ba1-c2d3e4f5a6b7';

/**
 * Builds a cached upstream with a UUID.
 *
 * @param id - Its id.
 * @param name - Its name.
 * @param sdl - Its schema.
 * @returns The upstream.
 */
function upstreamOf(id: string, name: string, sdl: string): Upstream {
  return { ...cachedUpstream(name, sdl), id };
}

let opened: OpenedDatabase;
let modules: ModuleService;
const known = new Map<string, Upstream>();

beforeAll(async () => {
  opened = await openTestDatabase();
  for (const upstream of [upstreamOf(SHOP_ID, 'shop', FIXTURE_SDL), upstreamOf(MEMOS_ID, 'memos', MEMO_SDL)]) {
    known.set(upstream.id, upstream);
  }
  const find = async (idOrName: string) =>
    [...known.values()].find((upstream) => upstream.id === idOrName || upstream.name === idOrName) ?? null;
  const upstreams: Pick<UpstreamService, 'find'> = { find };
  modules = createModuleService({
    db: opened.db,
    upstreams: upstreams as UpstreamService,
    allowedImports: async () => new Set(RUNTIME_IMPORTS),
  });
});
afterAll(() => opened.close());

describe('modules over several upstreams', () => {
  let moduleId = '';

  it('keeps the upstreams in the order given and checks each document against its own', async () => {
    const saved = await modules.save({ name: 'Both', upstreams: ['shop', 'memos'], source: SOURCE });
    expect(saved.compile.errors).toEqual([]);
    expect(saved.module.upstreamIds).toEqual([SHOP_ID, MEMOS_ID]);
    moduleId = saved.module.id;
    expect((await modules.find(moduleId))?.upstreamIds).toEqual([SHOP_ID, MEMOS_ID]);
  });

  it('fails a module whose default is the wrong upstream for its plain documents', async () => {
    const swapped = await modules.check(['memos', 'shop'], SOURCE.replace("gql.from('memos')", "gql.from('shop')"));
    expect(swapped.ok).toBe(false);
    expect(swapped.errors.map((error) => error.message).join('\n')).toMatch(/orders/);
  });

  it('replaces the list on a resave', async () => {
    const plain = SOURCE.replace(/const RETITLE[^\n]*\n/, '').replace('  useMutation(RETITLE);\n', '');
    const saved = await modules.save({ id: moduleId, name: 'Both', upstreams: ['shop'], source: plain });
    expect(saved.module.upstreamIds).toEqual([SHOP_ID]);
    const back = await modules.save({ id: moduleId, name: 'Both', upstreams: ['shop', 'memos'], source: SOURCE });
    expect(back.module.upstreamIds).toEqual([SHOP_ID, MEMOS_ID]);
    expect((await modules.list()).map((module) => module.upstreamIds)).toEqual([[SHOP_ID, MEMOS_ID]]);
  });

  it('re-checks a module through an upstream it lists second', async () => {
    known.set(MEMOS_ID, upstreamOf(MEMOS_ID, 'memos', MEMO_SDL_WITHOUT_RETITLE));
    expect(await modules.recheck('memos')).toBe(1);
    const failing = await modules.find(moduleId);
    expect(failing?.status).toBe(ModuleStatus.Failed);
    expect(failing?.errors[0]?.message).toMatch(/retitleMemo/);
    known.set(MEMOS_ID, upstreamOf(MEMOS_ID, 'memos', MEMO_SDL));
    expect(await modules.recheck('shop')).toBe(1);
    expect((await modules.find(moduleId))?.status).toBe(ModuleStatus.Ready);
  });

  it('refuses no upstreams, one listed twice, and an unknown one', async () => {
    const attempts = [
      { upstreams: [], code: ErrorCode.BadUserInput },
      { upstreams: ['shop', SHOP_ID], code: ErrorCode.BadUserInput },
      { upstreams: ['shop', 'nowhere'], code: ErrorCode.NotFound },
    ];
    for (const { upstreams, code } of attempts) {
      await expect(modules.save({ name: 'Bad', upstreams, source: SOURCE })).rejects.toMatchObject({
        extensions: { code },
      });
    }
  });
});
