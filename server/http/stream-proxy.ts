// Subscriptions through the proxy: `POST /proxy/:upstreamId` with `accept: text/event-stream`, in GraphQL over SSE's
// "distinct connections" mode. Each browser stream holds one upstream stream; either closing closes the other.
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import type { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import type { SubscriptionSettings } from '../core/defaults.ts';
import { ErrorCode, errorMessage } from '../core/errors.ts';
import type { GraphQLRequest, GraphQLResponseBody, UpstreamService } from '../core/services.ts';
import { HttpStatus, MS_PER_SECOND } from '../core/wire.ts';
import { EVENT_STREAM, SseEvent } from '../upstreams/sse.ts';
import { errorBody } from '../upstreams/upstream-service.ts';

/** The tag on this door's log lines. */
const LOG_TAG = '[streams]';
/** An SSE comment line: it keeps the connection busy and carries nothing. */
const KEEP_ALIVE = ':\n\n';

/** The proxy's stream door, and what shutdown needs from it. */
export interface StreamProxy {
  /**
   * Answers one stream request: refuses it as JSON, or streams until either side ends it.
   *
   * @param upstreamId - The upstream's id or name, from the path.
   * @param request - The subscription.
   * @param res - The Express response.
   */
  handle(upstreamId: string, request: GraphQLRequest, res: Response): Promise<void>;
  /**
   * Closes every open stream, both sides, without `complete`: clients reconnect to whatever serves next.
   *
   * @returns Once every response has ended, or after `closeGraceMs`, whichever is first.
   */
  closeAll(): Promise<void>;
  /** How many streams are open. */
  openCount(): number;
}

/** One open stream, as the door tracks it. */
interface OpenEntry {
  /** Closes both sides. */
  close: () => void;
  /** Settles once its response has ended. */
  ended: Promise<void>;
}

/**
 * Whether a request asks for a stream.
 *
 * @param req - The Express request.
 * @returns True when its `accept` names `text/event-stream`.
 */
export function wantsStream(req: Request): boolean {
  return (req.get('accept') ?? '').includes(EVENT_STREAM);
}

/**
 * The status a refusal goes out with, so a client can tell a request it must fix from a failure worth retrying.
 *
 * @param body - The refusal.
 * @returns 404 for no such upstream, 502 when the upstream failed, 400 for the rest.
 */
function statusOf(body: GraphQLResponseBody): HttpStatus {
  const code = (body.errors?.[0]?.extensions as { code?: unknown } | undefined)?.code;
  if (code === ErrorCode.NotFound) {
    return HttpStatus.NotFound;
  }
  return code === ErrorCode.UpstreamFailed ? HttpStatus.BadGateway : HttpStatus.BadRequest;
}

/**
 * Writes one chunk, waiting while the stream's buffer is full so a slow reader can't make it grow without bound.
 *
 * @param stream - The browser's stream.
 * @param chunk - What to write.
 * @param signal - Stops the wait when the stream is closed.
 * @returns Once the chunk is written and the buffer has room, or the signal aborted.
 */
export async function writeWithBackpressure(stream: Writable, chunk: string, signal: AbortSignal): Promise<void> {
  if (stream.write(chunk)) {
    return;
  }
  try {
    await once(stream, 'drain', { signal });
  } catch (error) {
    // An abort ends the wait; the caller checks the signal.
    if (signal.aborted === false) {
      throw error;
    }
  }
}

/**
 * Formats one SSE event.
 *
 * @param event - Its name.
 * @param [data] - Its data: JSON for `next`, nothing for `complete`.
 * @returns The event's text.
 */
function eventText(event: SseEvent, data = ''): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/**
 * Builds the stream door over the upstream service.
 *
 * @param upstreams - Opens the upstream side of each stream.
 * @param settings - The stream limits.
 * @returns The door.
 */
export function createStreamProxy(upstreams: UpstreamService, settings: SubscriptionSettings): StreamProxy {
  /** Each open stream, by the upstream it reads. */
  const open = new Map<string, Set<OpenEntry>>();
  let total = 0;

  /**
   * Refuses a stream before it opens, as a GraphQL server answers.
   *
   * @param res - The response.
   * @param body - The errors.
   * @param [status] - The status; worked out from the error code when left out.
   */
  const refuse = (res: Response, body: GraphQLResponseBody, status = statusOf(body)): void => {
    res.status(status).json(body);
  };

  /**
   * Says why a new stream would go over a limit.
   *
   * @param upstreamId - The upstream it would read.
   * @param name - Its name, for the message.
   * @returns The message, or null when it fits.
   */
  const limitMessageOf = (upstreamId: string, name: string): string | null => {
    if (total >= settings.maxStreams) {
      return `Symphony already holds ${settings.maxStreams} subscription streams, its limit. Try again once some close.`;
    }
    const perUpstream = open.get(upstreamId)?.size ?? 0;
    if (perUpstream >= settings.maxStreamsPerUpstream) {
      return `${name} already has ${settings.maxStreamsPerUpstream} subscription streams open, its limit. Try again once some close.`;
    }
    return null;
  };

  /**
   * Counts a stream as open.
   *
   * @param upstreamId - The upstream it reads.
   * @param entry - How to close it, and when it has ended.
   * @returns Uncounts it; calling it twice does nothing more.
   */
  const track = (upstreamId: string, entry: OpenEntry): (() => void) => {
    const entries = open.get(upstreamId) ?? new Set();
    open.set(upstreamId, entries);
    entries.add(entry);
    total += 1;
    let isTracked = true;
    return () => {
      if (isTracked === false) {
        return;
      }
      isTracked = false;
      entries.delete(entry);
      total -= 1;
      if (entries.size === 0) {
        open.delete(upstreamId);
      }
    };
  };

  /**
   * Opens one stream and copies it to the browser. A refusal goes out as JSON; once streaming, the response is ended
   * here.
   *
   * @param upstreamId - The upstream's id or name.
   * @param request - The subscription.
   * @param res - The Express response.
   */
  const stream = async (upstreamId: string, request: GraphQLRequest, res: Response): Promise<void> => {
    const upstream = await upstreams.find(upstreamId);
    if (upstream === null) {
      refuse(res, errorBody(`There is no upstream "${upstreamId}".`, ErrorCode.NotFound));
      return;
    }
    const overLimit = limitMessageOf(upstream.id, upstream.name);
    if (overLimit !== null) {
      refuse(res, errorBody(overLimit, ErrorCode.UpstreamFailed), HttpStatus.TooManyRequests);
      return;
    }
    // Counted before the upstream is asked, so streams opening at once can't pass the limit together.
    const closer = new AbortController();
    const close = () => closer.abort();
    let markEnded = () => {};
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    const untrack = track(upstream.id, { close, ended });
    // The browser leaving (or the response ending any other way) closes the upstream side.
    res.on('close', close);
    try {
      const opened = await upstreams.subscribe(upstream.id, request, {
        signal: closer.signal,
        maxEventBytes: settings.maxEventBytes,
      });
      if (opened.isOpen === false) {
        if (closer.signal.aborted === false) {
          refuse(res, opened.body);
        }
        return;
      }
      res.writeHead(HttpStatus.Ok, {
        'content-type': `${EVENT_STREAM}; charset=utf-8`,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // Tells nginx-style proxies not to buffer the stream.
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();
      await pipe(opened.events, res, closer);
    } finally {
      untrack();
      res.off('close', close);
      // Before the headers went out, a throw is the caller's to answer, as JSON.
      if (res.headersSent) {
        res.end();
      }
      markEnded();
    }
  };

  return {
    handle: async (upstreamId, request, res) => {
      try {
        await stream(upstreamId, request, res);
      } catch (error) {
        console.warn(LOG_TAG, errorMessage(error));
        if (res.headersSent) {
          res.end();
          return;
        }
        const code = error instanceof GraphQLError ? String(error.extensions.code) : ErrorCode.UpstreamFailed;
        refuse(res, errorBody(`Couldn't open the stream: ${errorMessage(error)}`, code));
      }
    },

    closeAll: async () => {
      const entries = [...open.values()].flatMap((set) => [...set]);
      if (entries.length === 0) {
        return;
      }
      console.log(LOG_TAG, `closing ${entries.length} open streams`);
      for (const entry of entries) {
        entry.close();
      }
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, settings.closeGraceMs);
      });
      await Promise.race([Promise.all(entries.map((entry) => entry.ended)), grace]);
      clearTimeout(graceTimer);
    },

    openCount: () => total,
  };

  /**
   * Copies an upstream's results to the browser until the upstream completes or the stream is closed. A stream with
   * no result for `idleTimeoutSeconds` is closed; keep-alive comments go out every `keepAliveSeconds` meanwhile.
   *
   * @param events - The upstream's results. The next one is read only once the browser has taken the last.
   * @param res - The browser's stream.
   * @param closer - Aborts both sides: the idle timer uses it, as do the browser leaving and shutdown.
   */
  async function pipe(
    events: AsyncIterable<GraphQLResponseBody>,
    res: Response,
    closer: AbortController,
  ): Promise<void> {
    const idleMs = settings.idleTimeoutSeconds * MS_PER_SECOND;
    let idleTimer = setTimeout(() => closer.abort(), idleMs);
    const keepAlive = setInterval(() => {
      // A full buffer already keeps the connection busy.
      if (res.writableNeedDrain === false) {
        res.write(KEEP_ALIVE);
      }
    }, settings.keepAliveSeconds * MS_PER_SECOND);
    try {
      for await (const result of events) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => closer.abort(), idleMs);
        await writeWithBackpressure(res, eventText(SseEvent.Next, JSON.stringify(result)), closer.signal);
        if (closer.signal.aborted) {
          return;
        }
      }
      res.write(eventText(SseEvent.Complete));
    } catch (error) {
      // Closed on purpose (idle, the browser left, shutdown): end quietly, so a client still there reconnects.
      if (closer.signal.aborted) {
        return;
      }
      // The upstream failed or dropped: say why, and end without `complete`, so the client reconnects.
      console.warn(LOG_TAG, errorMessage(error));
      res.write(eventText(SseEvent.Next, JSON.stringify(errorBody(errorMessage(error), ErrorCode.UpstreamFailed))));
    } finally {
      clearTimeout(idleTimer);
      clearInterval(keepAlive);
    }
  }
}
