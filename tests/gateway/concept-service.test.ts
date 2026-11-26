// The concept service on PGlite, over the memo upstream. Validation is asserted only as "problems or none", since
// the concept model is still changing; the definitions come from tests/fixtures/memo-upstream.ts.
import { ErrorCode } from '../../server/core/errors.ts';
import { createEventFeed } from '../../server/core/events.ts';
import type { ConceptService, SourcesChange, UpstreamService } from '../../server/core/services.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { createConceptService } from '../../server/gateway/concept-service.ts';
import { createUpstreamService } from '../../server/upstreams/upstream-service.ts';
import { openTestDatabase } from '../db.ts';
import {
  createMemoUpstream,
  MEMO_UPSTREAM,
  MEMO_URL,
  type MemoUpstream,
  noteConcept,
} from '../fixtures/memo-upstream.ts';

let opened: OpenedDatabase;
let memo: MemoUpstream;
let upstreams: UpstreamService;
let concepts: ConceptService;
const changes: SourcesChange[] = [];

beforeAll(async () => {
  opened = await openTestDatabase();
  memo = createMemoUpstream();
  upstreams = createUpstreamService({ db: opened.db, fetch: memo.fetch });
  const feed = createEventFeed<SourcesChange>('[test]');
  feed.subscribe((change) => {
    changes.push(change);
  });
  concepts = createConceptService({ db: opened.db, upstreams, changes: feed });
  await upstreams.add({ name: MEMO_UPSTREAM, url: MEMO_URL, headers: [] });
});
afterAll(() => opened.close());

/**
 * What a refused save is rejected with: BAD_USER_INPUT carrying located problems.
 *
 * @param [problem] - What one of the problems must match; any problem will do when left out.
 * @returns The matcher.
 */
function refusedWith(problem: unknown = expect.anything()) {
  return { extensions: { code: ErrorCode.BadUserInput, problems: expect.arrayContaining([problem]) } };
}

describe('concepts', () => {
  it('saves a concept that fits its member and finds it by name and id', async () => {
    const saved = await concepts.save(noteConcept());
    expect(saved.problems).toEqual([]);
    expect(saved.name).toBe('Note');
    expect(saved.definition).toEqual(noteConcept());
    expect((await concepts.find('Note'))?.id).toBe(saved.id);
    expect((await concepts.find(saved.id))?.name).toBe('Note');
    expect(changes.map((change) => change.reason)).toContain('concept Note saved');
  });

  it('replaces the concept with the same name instead of adding one', async () => {
    const before = await concepts.find('Note');
    const saved = await concepts.save(noteConcept());
    expect(saved.id).toBe(before?.id);
    expect((await concepts.list()).map((concept) => concept.name)).toEqual(['Note']);
  });

  it('refuses a definition that does not parse, with problems', async () => {
    await expect(concepts.save({ name: 'lowercase', fields: [] })).rejects.toMatchObject(refusedWith());
  });

  it("refuses a document that does not fit the member's schema, placed in that member", async () => {
    const definition = noteConcept('Broken', { fetch: 'query ($id: ID!) { memo(id: $id) { id nope } }' });
    await expect(concepts.save(definition)).rejects.toMatchObject(
      refusedWith(expect.objectContaining({ member: MEMO_UPSTREAM })),
    );
    expect(await concepts.find('Broken')).toBeNull();
  });

  it('refuses members that are no upstream, or have no cached schema', async () => {
    const unknown = noteConcept('Orphan', {}, 'nowhere');
    await expect(concepts.save(unknown)).rejects.toMatchObject(
      refusedWith(expect.objectContaining({ member: 'nowhere' })),
    );

    const offline = createUpstreamService({ db: opened.db, fetch: () => Promise.reject(new Error('unreachable')) });
    await offline.add({ name: 'offline', url: 'http://offline.test/graphql', headers: [] });
    const uncached = noteConcept('Uncached', {}, 'offline');
    await expect(concepts.save(uncached)).rejects.toMatchObject(
      refusedWith(expect.objectContaining({ member: 'offline' })),
    );
  });

  it('keeps listing a concept an upstream change broke, with its problems', async () => {
    memo.withoutRetitle = true;
    await upstreams.refresh(MEMO_UPSTREAM);
    const [note] = await concepts.list();
    expect(note?.name).toBe('Note');
    expect(note?.problems.length).toBeGreaterThan(0);
    expect((await concepts.find('Note'))?.problems.length).toBeGreaterThan(0);
    memo.withoutRetitle = false;
    await upstreams.refresh(MEMO_UPSTREAM);
    expect((await concepts.find('Note'))?.problems).toEqual([]);
  });

  it('removes a concept by id or name', async () => {
    expect(await concepts.remove('Note')).toBe(true);
    expect(await concepts.remove('Note')).toBe(false);
    expect(await concepts.list()).toEqual([]);
    expect(changes.at(-1)?.reason).toBe('concept Note removed');
  });
});
