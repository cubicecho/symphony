// Server-sent events as GraphQL over SSE ("distinct connections" mode) uses them: each event is a `next` with one
// execution result, and a `complete` ends the stream. The proxy reads them from an upstream and writes them to the
// browser with the same two names.
import { upstreamFailed } from '../core/errors.ts';

/** The media type of an SSE stream. */
export const EVENT_STREAM = 'text/event-stream';

/** The event names GraphQL over SSE sends. */
export const SseEvent = {
  /** One execution result, as JSON in `data`. */
  Next: 'next',
  /** The operation is done; `data` is empty. */
  Complete: 'complete',
} as const;
export type SseEvent = (typeof SseEvent)[keyof typeof SseEvent];

/** One event as it arrived. */
export interface ServerSentEvent {
  /** Its `event:` field; `message` when it had none, as the SSE spec says. */
  event: string;
  /** Its `data:` lines, joined with newlines. */
  data: string;
}

/** What an event is called when it names nothing. */
const DEFAULT_EVENT = 'message';
/** A line ends at CRLF, LF or CR. */
const LINE_END = /\r\n|\n|\r/;

/**
 * Reads one SSE block (the lines between two blank lines) into an event.
 *
 * @param block - The block's lines.
 * @returns The event, or null for a block of only comments (keep-alives), which carries nothing.
 */
function eventOf(block: readonly string[]): ServerSentEvent | null {
  let event = DEFAULT_EVENT;
  const data: string[] = [];
  for (const line of block) {
    const colon = line.indexOf(':');
    if (colon === 0) {
      continue;
    }
    const field = colon === -1 ? line : line.slice(0, colon);
    const rest = colon === -1 ? '' : line.slice(colon + 1);
    const value = rest.startsWith(' ') ? rest.slice(1) : rest;
    if (field === 'event') {
      event = value;
    }
    if (field === 'data') {
      data.push(value);
    }
  }
  const hasFields = event !== DEFAULT_EVENT || data.length > 0;
  return hasFields ? { event, data: data.join('\n') } : null;
}

/**
 * Fails a stream whose current event has grown past the limit.
 *
 * @param bytes - The event's size so far.
 * @param maxEventBytes - The limit.
 * @throws UPSTREAM_FAILED when it is over.
 */
function refuseOversize(bytes: number, maxEventBytes: number): void {
  if (bytes > maxEventBytes) {
    throw upstreamFailed(`The upstream sent an event over the ${maxEventBytes}-byte limit.`);
  }
}

/** What reading a stream takes besides the body. */
export interface ReadEventsOptions {
  /** The largest event read; a longer one fails the stream rather than fill memory. */
  maxEventBytes: number;
  /** Aborting it cancels the body, which ends the events and closes the connection under it. */
  signal: AbortSignal;
}

/**
 * Reads a stream of server-sent events.
 *
 * @param body - The response body.
 * @param options - The largest event, and the signal that stops reading.
 * @returns The events in order, ending when the body ends or the signal aborts.
 * @throws UPSTREAM_FAILED when one event is over `maxEventBytes`.
 *
 * @remarks
 * The body is read by hand rather than with `for await`, so an abort can cancel a read that is waiting: `return()`
 * can't stop a generator that waits on a chunk, and a quiet upstream would keep its connection open.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  { maxEventBytes, signal }: ReadEventsOptions,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let pending = '';
  let block: string[] = [];
  let blockBytes = 0;
  try {
    for (let read = await reader.read(); read.done === false; read = await reader.read()) {
      const text = pending + decoder.decode(read.value, { stream: true });
      // A CR at the end may be the first half of a CRLF, so it waits for the next chunk with the half line before it.
      const heldCr = text.endsWith('\r') ? '\r' : '';
      const lines = text.slice(0, text.length - heldCr.length).split(LINE_END);
      pending = (lines.pop() ?? '') + heldCr;
      for (const line of lines) {
        if (line !== '') {
          block.push(line);
          blockBytes += Buffer.byteLength(line);
          refuseOversize(blockBytes, maxEventBytes);
          continue;
        }
        const event = eventOf(block);
        block = [];
        blockBytes = 0;
        if (event !== null) {
          yield event;
        }
      }
      refuseOversize(blockBytes + Buffer.byteLength(pending), maxEventBytes);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    // Leaving early, for an oversize event or a reader that stopped, closes the connection too.
    cancel();
  }
}
