// The unified service over in-memory upstreams, concepts and wiring: when it composes, what it serves, and what it
// does when a composition fails. The wiring here is a fake WiringService, so nothing in it waits on wiring.ts.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createEventFeed } from '../../server/core/events.ts';
import {
  type ConceptService,
  type SourcesChange,
  UnifiedProblemKind,
  UnifiedState,
  type Upstream,
  UpstreamChange,
  type UpstreamEvent,
  type UpstreamService,
  type WiringService,
} from '../../server/core/services.ts';
import {
  createUnifiedService,
  UNIFIED_ENDPOINT,
  type UnifiedGatewayService,
} from '../../server/gateway/unified-service.ts';
import { cachedUpstream, createMemoUpstream, MEMO_SDL, MEMO_UPSTREAM } from '../fixtures/memo-upstream.ts';

/** Clashes with the memo upstream's `Memo.id: ID!`, so the two can't compose. */
const CLASHING_SDL = 'type Memo { id: Int! }\ntype Query { otherMemo: Memo }';

/** What a test changes and counts. */
interface World {
  /** What the fake upstream service lists; tests replace it. */
  upstreams: Upstream[];
  /** How many compositions read the wiring, i.e. how many ran. */
  compositions: number;
  /** The most compositions running at once. */
  mostAtOnce: number;
}

/** Fails the test that calls it: the unified service reads, it never writes. */
const unused = async (): Promise<never> => {
  throw new Error('The unified service does not call this.');
};

/**
 * Builds a unified service over fakes, not started.
 *
 * @param upstreams - The upstreams it composes.
 * @returns The service, what it counts, its feeds and the memo upstream it reaches.
 */
function createWorld(upstreams: Upstream[]) {
  const world: World = { upstreams, compositions: 0, mostAtOnce: 0 };
  let running = 0;
  const memo = createMemoUpstream();
  const changes = createEventFeed<SourcesChange>('[test]');
  const upstreamEvents = createEventFeed<UpstreamEvent>('[test]');
  const upstreamService: UpstreamService = {
    list: async () => world.upstreams,
    find: unused,
    add: unused,
    update: unused,
    remove: unused,
    refresh: unused,
    execute: async () => ({ data: null }),
  };
  const concepts: ConceptService = { list: async () => [], find: unused, save: unused, remove: unused };
  const wiring: WiringService = {
    effective: async () => {
      world.compositions += 1;
      running += 1;
      world.mostAtOnce = Math.max(world.mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { wiring: [], problems: [] };
    },
    find: unused,
    setOverride: unused,
    clearOverride: unused,
  };
  const unified = createUnifiedService(
    {
      upstreams: upstreamService,
      concepts,
      wiring,
      changes,
      upstreamEvents,
      fetch: memo.fetch,
      env: { SYMPHONY_MEMO_TOKEN: 'memo-secret' },
    },
    { recomposeDebounceMs: 10 },
  );
  return { world, unified, changes, upstreamEvents, memo };
}

/**
 * Serves a unified service's handler on an ephemeral port.
 *
 * @param unified - The service.
 * @returns The endpoint's URL and a close.
 */
async function serve(unified: UnifiedGatewayService): Promise<{ url: string; server: Server }> {
  const app = express();
  app.use(UNIFIED_ENDPOINT, express.json());
  app.all(UNIFIED_ENDPOINT, unified.handler);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}${UNIFIED_ENDPOINT}`, server };
}

/**
 * Posts one query.
 *
 * @param url - The endpoint.
 * @param query - The document.
 * @returns The status and body.
 */
async function post(url: string, query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: response.status, body: await response.json() };
}

describe('the unified service', () => {
  let built: ReturnType<typeof createWorld>;
  let url: string;
  let server: Server;

  beforeAll(async () => {
    const headers = [{ name: 'authorization', value: 'Bearer ${env:SYMPHONY_MEMO_TOKEN}' }];
    built = createWorld([cachedUpstream(MEMO_UPSTREAM, MEMO_SDL, headers)]);
    ({ url, server } = await serve(built.unified));
  });
  afterAll(async () => {
    await built.unified.dispose();
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers 503 before its first composition', async () => {
    expect(built.unified.status().state).toBe(UnifiedState.Starting);
    const { status, body } = await post(url, '{ memos { id } }');
    expect(status).toBe(503);
    expect(JSON.stringify(body)).toMatch(/starting/);
  });

  it('ignores changes until it is started', async () => {
    built.unified.requestRecompose('too early');
    await built.unified.whenIdle();
    expect(built.world.compositions).toBe(0);
  });

  it('composes on start and serves an upstream whose name is no GraphQL name, its secret resolved here', async () => {
    built.unified.start();
    await built.unified.whenIdle();
    const status = built.unified.status();
    expect(status).toMatchObject({ state: UnifiedState.Ready, lastError: null });
    expect(status.sources).toEqual([{ name: MEMO_UPSTREAM, kind: 'graphql' }]);
    expect(status.composedAt).toBeInstanceOf(Date);
    const { body } = await post(url, '{ memos { id title } }');
    expect(body).toEqual({ data: { memos: [{ id: 'm1', title: 'First' }] } });
    expect(built.memo.lastHeaders?.get('authorization')).toBe('Bearer memo-secret');
  });

  it('coalesces a burst of changes into one composition, never two at once', async () => {
    const before = built.world.compositions;
    await built.changes.emit({ reason: 'concept saved' });
    await built.changes.emit({ reason: 'override set' });
    await built.upstreamEvents.emit({
      change: UpstreamChange.Refreshed,
      id: 'x',
      name: MEMO_UPSTREAM,
      previousName: MEMO_UPSTREAM,
    });
    await built.unified.whenIdle();
    expect(built.world.compositions - before).toBe(1);
    built.unified.requestRecompose('one');
    await new Promise((resolve) => setTimeout(resolve, 15));
    built.unified.requestRecompose('while the first runs');
    await built.unified.whenIdle();
    expect(built.world.mostAtOnce).toBe(1);
  });

  it('keeps serving the last good supergraph when a recompose fails, naming the issues', async () => {
    built.world.upstreams = [...built.world.upstreams, cachedUpstream('other.api', CLASHING_SDL)];
    built.unified.requestRecompose('a clashing upstream');
    await built.unified.whenIdle();
    const status = built.unified.status();
    expect(status.state).toBe(UnifiedState.Ready);
    expect(status.lastError?.issues.length).toBeGreaterThan(0);
    expect(status.sources).toEqual([{ name: MEMO_UPSTREAM, kind: 'graphql' }]);
    const { body } = await post(url, '{ memos { id } }');
    expect(body).toEqual({ data: { memos: [{ id: 'm1' }] } });
  });

  it('leaves out an upstream whose header secret is not set, as a source problem', async () => {
    const unset = [{ name: 'x-key', value: '${env:SYMPHONY_UNSET}' }];
    built.world.upstreams = [cachedUpstream(MEMO_UPSTREAM, MEMO_SDL), cachedUpstream('locked', CLASHING_SDL, unset)];
    built.unified.requestRecompose('a locked upstream');
    await built.unified.whenIdle();
    const status = built.unified.status();
    expect(status.lastError).toBeNull();
    expect(status.problems).toEqual([expect.objectContaining({ kind: UnifiedProblemKind.Source, source: 'locked' })]);
  });
});

describe('a unified service whose first composition fails', () => {
  it('reports failed, and serves 503 saying why', async () => {
    const built = createWorld([]);
    const { url, server } = await serve(built.unified);
    built.unified.start();
    await built.unified.whenIdle();
    expect(built.unified.status()).toMatchObject({ state: UnifiedState.Failed, composedAt: null });
    expect(built.unified.status().lastError?.message).toMatch(/nothing to compose/);
    const { status } = await post(url, '{ memos { id } }');
    expect(status).toBe(503);
    await built.unified.dispose();
    await new Promise((resolve) => server.close(resolve));
  });
});
