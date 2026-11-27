import { readServerSentEvents, type ServerSentEvent } from '../../server/upstreams/sse.ts';

/**
 * Makes a body that arrives in the given chunks.
 *
 * @param chunks - The text of each chunk.
 * @returns The stream.
 */
function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/**
 * Reads every event of a body.
 *
 * @param chunks - The body's chunks.
 * @param [maxEventBytes] - The event size limit.
 * @returns The events.
 */
async function eventsOf(chunks: readonly string[], maxEventBytes = 1000): Promise<ServerSentEvent[]> {
  const events: ServerSentEvent[] = [];
  const signal = new AbortController().signal;
  for await (const event of readServerSentEvents(bodyOf(chunks), { maxEventBytes, signal })) {
    events.push(event);
  }
  return events;
}

describe('readServerSentEvents', () => {
  it('reads events split anywhere across chunks, CRLFs included', async () => {
    const events = await eventsOf(['event: ne', 'xt\r', '\ndata: {"a":', '1}\r\n\r', '\nevent: complete\ndata:\n\n']);
    expect(events).toEqual([
      { event: 'next', data: '{"a":1}' },
      { event: 'complete', data: '' },
    ]);
  });

  it('skips keep-alive comments and joins data lines', async () => {
    const events = await eventsOf([':\n\n', ': ping\n\n', 'data: one\ndata: two\n\n']);
    expect(events).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  it('refuses an event over the limit, even one that arrives whole', async () => {
    await expect(eventsOf([`event: next\ndata: ${'x'.repeat(50)}\n\n`], 20)).rejects.toThrow(/20-byte limit/);
  });

  it('stops when the signal aborts, even while waiting for a chunk', async () => {
    const leaving = new AbortController();
    const quiet = new ReadableStream<Uint8Array>({ start: () => {} });
    const reading = readServerSentEvents(quiet, { maxEventBytes: 1000, signal: leaving.signal }).next();
    leaving.abort();
    expect(await reading).toEqual({ done: true, value: undefined });
  });
});
