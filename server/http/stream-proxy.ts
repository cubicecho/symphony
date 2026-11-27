// Subscriptions through the proxy: `POST /proxy/:upstreamId` with `accept: text/event-stream`, in GraphQL over SSE's
// "distinct connections" mode. Each browser stream holds one upstream stream; either closing closes the other.
import type { Request, Response } from 'express';
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
  /** Closes every open stream, both sides, without `complete`: clients reconnect to whatever serves next. */
  closeAll(): void;
  /** How many streams are open. */
  openCount(): number;
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
 * Writes one SSE event.
 *
 * @param res - The stream.
 * @param event - Its name.
 * @param [data] - Its data: JSON for `next`, nothing for `complete`.
 */
function writeEvent(res: Response, event: SseEvent, data = ''): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

/**
 * Builds the stream door over the upstream service.
 *
 * @param upstreams - Opens the upstream side of each stream.
 * @param settings - The stream limits.
 * @returns The door.
 */
export function createStreamProxy(upstreams: UpstreamService, settings: SubscriptionSettings): StreamProxy {
  /** Each open stream's close, by the upstream it reads. */
  const open = new Map<string, Set<() => void>>();
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
   * @param close - Closes it.
   * @returns Uncounts it; calling it twice does nothing more.
   */
  const track = (upstreamId: string, close: () => void): (() => void) => {
    const closes = open.get(upstreamId) ?? new Set();
    open.set(upstreamId, closes);
    closes.add(close);
    total += 1;
    let isTracked = true;
    return () => {
      if (isTracked === false) {
        return;
      }
      isTracked = false;
      closes.delete(close);
      total -= 1;
      if (closes.size === 0) {
        open.delete(upstreamId);
      }
    };
  };

  return {
    handle: async (upstreamId, request, res) => {
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
      const untrack = track(upstream.id, close);
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
        res.end();
      }
    },

    closeAll: () => {
      const closes = [...open.values()].flatMap((set) => [...set]);
      if (closes.length > 0) {
        console.log(LOG_TAG, `closing ${closes.length} open streams`);
      }
      for (const close of closes) {
        close();
      }
    },

    openCount: () => total,
  };

  /**
   * Copies an upstream's results to the browser until the upstream completes or the stream is closed. A stream with
   * no result for `idleTimeoutSeconds` is closed; keep-alive comments go out every `keepAliveSeconds` meanwhile.
   *
   * @param events - The upstream's results.
   * @param res - The browser's stream.
   * @param closer - Aborts both sides: the idle timer uses it, as do the browser leaving and shutdown.
   */
  async function pipe(
    events: AsyncIterable<GraphQLResponseBody>,
    res: Response,
    closer: AbortController,
  ): Promise<void> {
    let idleTimer = setTimeout(() => closer.abort(), settings.idleTimeoutSeconds * MS_PER_SECOND);
    const keepAlive = setInterval(() => res.write(KEEP_ALIVE), settings.keepAliveSeconds * MS_PER_SECOND);
    try {
      for await (const result of events) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => closer.abort(), settings.idleTimeoutSeconds * MS_PER_SECOND);
        writeEvent(res, SseEvent.Next, JSON.stringify(result));
      }
      writeEvent(res, SseEvent.Complete);
    } catch (error) {
      // Closed on purpose (idle, the browser left, shutdown): end quietly, so a client still there reconnects.
      if (closer.signal.aborted) {
        return;
      }
      // The upstream failed or dropped: say why, and end without `complete`, so the client reconnects.
      console.warn(LOG_TAG, errorMessage(error));
      writeEvent(res, SseEvent.Next, JSON.stringify(errorBody(errorMessage(error), ErrorCode.UpstreamFailed)));
    } finally {
      clearTimeout(idleTimer);
      clearInterval(keepAlive);
    }
  }
}
