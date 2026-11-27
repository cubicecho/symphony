import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { createApp } from '../../server/http/app.ts';
import type { StreamProxy } from '../../server/http/stream-proxy.ts';
import { RequestError, StreamDroppedError, streamGraphQL } from '../../web/src/core/gql.ts';
import { openTestDatabase } from '../db.ts';
import { createRunFixture, RUN_FIXTURE_URL, type RunFixture } from '../fixtures/run-upstream.ts';

/** One SSE event as the browser reads it. */
interface StreamEvent {
  event: string;
  data: string;
}

const RUN_EVENTS =
  'subscription Run($runId: String!, $isRunning: Boolean, $textBytes: Int) { runEvents(runId: $runId, isRunning: $isRunning, textBytes: $textBytes) { seq text } }';

let opened: OpenedDatabase;
let runs: RunFixture;
let streams: StreamProxy;
let base = '';
let upstreamId = '';
let close: () => void = () => {};

/**
 * Posts one operation to the upstream's proxy path.
 *
 * @param body - The request body.
 * @param [accept] - What the caller takes.
 * @param [signal] - Aborts the request.
 * @returns The response.
 */
function post(body: Record<string, unknown>, accept = 'text/event-stream', signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/proxy/${upstreamId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
}

/**
 * Reads SSE events off a response, stopping early once `isEnough` says so.
 *
 * @param response - The streaming response.
 * @param [isEnough] - Checked after each event; the body is left unread past it.
 * @returns The events read, keep-alive comments left out.
 */
async function readEvents(
  response: Response,
  isEnough: (events: StreamEvent[]) => boolean = () => false,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (let read = await reader.read(); read.done === false; read = await reader.read()) {
    const blocks = (pending + decoder.decode(read.value, { stream: true })).split('\n\n');
    pending = blocks.pop() ?? '';
    for (const block of blocks.filter((one) => one.startsWith(':') === false)) {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const data = /^data: ?(.*)$/m.exec(block)?.[1] ?? '';
      events.push({ event, data });
      if (isEnough(events)) {
        reader.releaseLock();
        return events;
      }
    }
  }
  return events;
}

beforeAll(async () => {
  opened = await openTestDatabase();
  runs = createRunFixture();
  const built = createApp({
    db: opened.db,
    mcpKey: 'test-key',
    checkDatabase: () => opened.db.execute(sql`select 1`),
    fetch: runs.fetch,
    subscriptions: { idleTimeoutSeconds: 1, maxStreamsPerUpstream: 2, maxEventBytes: 2000 },
  });
  streams = built.streams;
  const server = built.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
  const upstream = await built.services.upstreams.add({ name: 'runs', url: RUN_FIXTURE_URL, headers: [] });
  upstreamId = upstream.id;
});
afterAll(async () => {
  streams.closeAll();
  close();
  await opened.close();
});

describe('subscriptions through the proxy', () => {
  it('streams every event, then completes', async () => {
    const response = await post({ query: RUN_EVENTS, variables: { runId: 'r1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const events = await readEvents(response);
    expect(events.map((one) => one.event)).toEqual(['next', 'next', 'next', 'complete']);
    expect(JSON.parse(events[0]?.data ?? '')).toEqual({ data: { runEvents: { seq: 1, text: 'r1 step 1' } } });
    await runs.allClosed();
  });

  it('refuses an invalid document as JSON before any stream opens', async () => {
    const response = await post({ query: 'subscription { runEvents(runId: "r1") { nope } }' });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/json/);
    const body = await response.json();
    expect(body.errors[0].message).toMatch(/nope/);
    expect(runs.openStreams()).toBe(0);
  });

  it('streams only subscriptions, and answers only the rest as JSON', async () => {
    const query = await post({ query: '{ runEvents(runId: "r1") { seq } }' });
    expect(query.status).toBe(400);
    expect((await query.json()).errors[0].message).toMatch(/Only a subscription streams/);
    const asJson = await post({ query: RUN_EVENTS, variables: { runId: 'r1' } }, 'application/json');
    expect((await asJson.json()).errors[0].message).toMatch(/text\/event-stream/);
    const plain = await post({ query: '{ runEvents(runId: "r1", afterSeq: 2) { seq } }' }, 'application/json');
    expect(await plain.json()).toEqual({ data: { runEvents: [{ seq: 3 }] } });
  });

  it('closes the upstream stream when the browser disconnects', async () => {
    const leaving = new AbortController();
    const response = await post(
      { query: RUN_EVENTS, variables: { runId: 'r2', isRunning: true } },
      undefined,
      leaving.signal,
    );
    const events = await readEvents(response, (read) => read.length === 3);
    expect(events.map((one) => one.event)).toEqual(['next', 'next', 'next']);
    expect(runs.openStreams()).toBe(1);
    leaving.abort();
    await runs.allClosed();
    await vi.waitFor(() => expect(streams.openCount()).toBe(0));
  });

  it('closes a stream with no event for the idle timeout, without completing it', async () => {
    const response = await post({ query: RUN_EVENTS, variables: { runId: 'r3', isRunning: true } });
    const events = await readEvents(response);
    expect(events.map((one) => one.event)).toEqual(['next', 'next', 'next']);
    await runs.allClosed();
  });

  it('refuses a stream over the per-upstream limit', async () => {
    const leaving = new AbortController();
    const holding = await Promise.all(
      ['r4', 'r5'].map((runId) =>
        post({ query: RUN_EVENTS, variables: { runId, isRunning: true } }, undefined, leaving.signal),
      ),
    );
    expect(holding.map((one) => one.status)).toEqual([200, 200]);
    const refused = await post({ query: RUN_EVENTS, variables: { runId: 'r6' } });
    expect(refused.status).toBe(429);
    expect((await refused.json()).errors[0].message).toMatch(/2 subscription streams open/);
    leaving.abort();
    await runs.allClosed();
  });

  it('ends a stream whose event is over the size limit, saying why', async () => {
    const response = await post({ query: RUN_EVENTS, variables: { runId: 'r7', textBytes: 5000 } });
    const events = await readEvents(response);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.data ?? '').errors[0].message).toMatch(/over the 2000-byte limit/);
    await runs.allClosed();
  });

  it('closes every stream, both sides, on shutdown', async () => {
    const response = await post({ query: RUN_EVENTS, variables: { runId: 'r8', isRunning: true } });
    await readEvents(response, (read) => read.length === 3).then(() => undefined);
    expect(runs.openStreams()).toBe(1);
    streams.closeAll();
    await runs.allClosed();
  });
});

describe("the runtime's stream client", () => {
  /**
   * Streams one subscription with the browser's client.
   *
   * @param variables - The subscription's variables.
   * @param [query] - The document.
   * @returns Whether it opened, and the results it handed over.
   */
  async function stream(variables: Record<string, unknown>, query = RUN_EVENTS) {
    const results: unknown[] = [];
    let isOpen = false;
    const handlers = {
      onOpen: () => {
        isOpen = true;
      },
      onNext: (result: unknown) => {
        results.push(result);
      },
    };
    await streamGraphQL(`${base}/proxy/${upstreamId}`, { query, variables }, handlers, new AbortController().signal);
    return { isOpen, results };
  }

  it('hands over each result and resolves on complete', async () => {
    const { isOpen, results } = await stream({ runId: 'c1' });
    expect(isOpen).toBe(true);
    expect(results).toHaveLength(3);
    expect(results[2]).toEqual({ data: { runEvents: { seq: 3, text: 'c1 step 3' } } });
  });

  it('throws a RequestError for a refusal, and a StreamDroppedError for a stream that ends early', async () => {
    const invalid = 'subscription { runEvents(runId: "c2") { nope } }';
    await expect(stream({}, invalid)).rejects.toBeInstanceOf(RequestError);
    // The idle timeout ends a stream that stays open, without `complete`.
    await expect(stream({ runId: 'c3', isRunning: true })).rejects.toBeInstanceOf(StreamDroppedError);
    await runs.allClosed();
  });
});
