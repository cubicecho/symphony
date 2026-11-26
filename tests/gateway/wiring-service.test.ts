// The wiring service on PGlite. wiring.ts is still a stub, so the derivation runs FAKE_WIRING_FUNCTIONS; once it is
// implemented, drop `...FAKE_WIRING_FUNCTIONS` below and tighten the effective-wiring assertions to the real output.
import { ErrorCode } from '../../server/core/errors.ts';
import { createEventFeed } from '../../server/core/events.ts';
import type {
  ConceptService,
  SourcesChange,
  UpstreamEvent,
  UpstreamService,
  WiringService,
} from '../../server/core/services.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { createConceptService } from '../../server/gateway/concept-service.ts';
import { CONCEPT_SOURCE_NAME } from '../../server/gateway/wiring.ts';
import { createWiringService } from '../../server/gateway/wiring-service.ts';
import { createUpstreamService } from '../../server/upstreams/upstream-service.ts';
import { openTestDatabase } from '../db.ts';
import {
  createMemoUpstream,
  FAKE_WIRING_FUNCTIONS,
  MEMO_UPSTREAM,
  MEMO_URL,
  noteConcept,
} from '../fixtures/memo-upstream.ts';

const OVERRIDE = { renames: { types: { Memo: 'Note' }, fields: { 'Query.memo': 'noteMemo' } } };

let opened: OpenedDatabase;
let upstreams: UpstreamService;
let concepts: ConceptService;
let wiring: WiringService;
const changes: SourcesChange[] = [];

beforeAll(async () => {
  opened = await openTestDatabase();
  const upstreamEvents = createEventFeed<UpstreamEvent>('[test]');
  const feed = createEventFeed<SourcesChange>('[test]');
  feed.subscribe((change) => {
    changes.push(change);
  });
  upstreams = createUpstreamService({ db: opened.db, fetch: createMemoUpstream().fetch, events: upstreamEvents });
  concepts = createConceptService({ db: opened.db, upstreams });
  wiring = createWiringService({
    db: opened.db,
    concepts,
    upstreams,
    changes: feed,
    upstreamEvents,
    ...FAKE_WIRING_FUNCTIONS,
  });
  await upstreams.add({ name: MEMO_UPSTREAM, url: MEMO_URL, headers: [] });
});
afterAll(() => opened.close());

describe('wiring', () => {
  it('has no wiring, and runs no wiring function, while nothing generates or overrides any', async () => {
    const stubbed = createWiringService({ db: opened.db, concepts, upstreams });
    expect(await stubbed.effective()).toEqual({ wiring: [], problems: [] });
  });

  it("derives wiring for a servable concept's members", async () => {
    await concepts.save(noteConcept());
    const { wiring: effective } = await wiring.effective();
    expect(effective.map((one) => one.upstream)).toEqual([MEMO_UPSTREAM]);
    expect(await wiring.find(MEMO_UPSTREAM)).toMatchObject({ override: null });
  });

  it('stores an override, named for its source, and recomposes', async () => {
    const effective = await wiring.setOverride(MEMO_UPSTREAM, OVERRIDE);
    expect(effective.override).toEqual({ ...OVERRIDE, upstream: MEMO_UPSTREAM });
    expect(effective.renames.types).toEqual({ Memo: 'Note' });
    expect(changes.at(-1)?.reason).toBe(`wiring override for ${MEMO_UPSTREAM} set`);
  });

  it('accepts an override for the concept subgraph', async () => {
    const effective = await wiring.setOverride(CONCEPT_SOURCE_NAME, { removeMergeKeys: ['Note'] });
    expect(effective.upstream).toBe(CONCEPT_SOURCE_NAME);
    expect(await wiring.clearOverride(CONCEPT_SOURCE_NAME)).toBe(true);
  });

  it('refuses an unknown source, an override of the wrong shape, and one naming another source', async () => {
    await expect(wiring.setOverride('nowhere', OVERRIDE)).rejects.toMatchObject({
      extensions: { code: ErrorCode.NotFound },
    });
    await expect(wiring.setOverride(MEMO_UPSTREAM, { renames: { types: { Memo: 3 } } })).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
    await expect(wiring.setOverride(MEMO_UPSTREAM, { mergeKeys: [{ type: 'Note' }] })).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
    await expect(wiring.setOverride(MEMO_UPSTREAM, { upstream: 'other', ...OVERRIDE })).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
  });

  it('moves an override with its upstream when the upstream is renamed', async () => {
    const memo = await upstreams.find(MEMO_UPSTREAM);
    await upstreams.update(memo?.id ?? '', { name: 'memos', url: MEMO_URL, headers: [] });
    const moved = await wiring.find('memos');
    expect(moved?.override).toEqual({ ...OVERRIDE, upstream: 'memos' });
    expect(await wiring.find(MEMO_UPSTREAM)).toBeNull();
  });

  it('deletes an override with its upstream', async () => {
    const memo = await upstreams.find('memos');
    await upstreams.remove(memo?.id ?? '');
    expect(await wiring.clearOverride('memos')).toBe(false);
  });

  it('says whether there was an override to clear', async () => {
    expect(await wiring.clearOverride(MEMO_UPSTREAM)).toBe(false);
  });
});
