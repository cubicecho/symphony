import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';

/** The admin API. The browser talks to its own origin; Vite proxies `/graphql` to the server in dev. */
const ADMIN_ENDPOINT = '/graphql';

/** One entry of a response's `errors`. */
interface GraphQLErrorEntry {
  message: string;
  extensions?: { code?: string; [key: string]: unknown };
}

/** A GraphQL response body, as far as the app reads it. */
export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLErrorEntry[];
}

/** What one GraphQL request sends. */
export interface GraphQLOperation {
  /** The document's text. */
  query: string;
  /** Its variables; left out when it takes none. */
  variables?: Record<string, unknown> | undefined;
  /** Which operation in the document to run, when it names one. */
  operationName?: string | null | undefined;
}

/**
 * A request the server answered with errors. `code` is the first error's `extensions.code`, when it has one, and
 * `extensions` the whole of them: a refused saveConcept carries its located problems there.
 */
export class RequestError extends Error {
  readonly code: string | undefined;
  readonly extensions: Readonly<Record<string, unknown>> | undefined;

  /**
   * Joins the messages of a GraphQL error list into one error.
   *
   * @param errors - The `errors` member of a response.
   */
  constructor(errors: GraphQLErrorEntry[]) {
    super(errors.map((error) => error.message).join('; '));
    this.name = 'RequestError';
    this.code = errors[0]?.extensions?.code;
    this.extensions = errors[0]?.extensions;
  }
}

/**
 * Reads a response body as GraphQL JSON, or explains why it is not.
 *
 * @param response - The fetch response.
 * @returns The parsed body.
 * @throws An `Error` naming the HTTP status when the body is not JSON.
 */
async function readBody<T>(response: Response): Promise<GraphQLResponse<T>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as GraphQLResponse<T>;
  } catch {
    throw new Error(`The server answered HTTP ${response.status} with something that is not GraphQL JSON.`);
  }
}

/**
 * Posts one GraphQL operation to an endpoint: the admin API or an upstream's proxy path.
 *
 * @typeParam T - What `data` holds.
 * @param endpoint - Where to post, on this origin.
 * @param operation - The document, its variables and its operation name.
 * @returns The response's `data`.
 * @throws A `RequestError` when the response carries errors, an `Error` when it carries no data.
 */
export async function postGraphQL<T>(endpoint: string, operation: GraphQLOperation): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(operation),
  });
  const body = await readBody<T>(response);
  // GraphQL reports failures in the body, often with a 200, so the status alone proves nothing.
  const hasErrors = body.errors !== undefined && body.errors.length > 0;
  if (hasErrors) {
    throw new RequestError(body.errors ?? []);
  }
  if (body.data === undefined || body.data === null) {
    throw new Error(`The server sent no data (HTTP ${response.status}).`);
  }
  return body.data;
}

/**
 * Sends one admin API request, typed by its document.
 *
 * @param document - The typed query or mutation.
 * @param variables - Its variables, left out when it takes none.
 * @returns The response's `data`.
 */
export async function request<TResult, TVariables>(
  document: TypedDocumentNode<TResult, TVariables>,
  ...[variables]: TVariables extends Record<string, never> ? [] : [TVariables]
): Promise<TResult> {
  return postGraphQL<TResult>(ADMIN_ENDPOINT, {
    query: print(document),
    variables: variables as Record<string, unknown> | undefined,
  });
}

/**
 * Fetches a text file from this origin: a compiled module's code.
 *
 * @param url - Where it is.
 * @returns The body.
 * @throws An `Error` naming the URL and the status when the server does not answer 2xx.
 */
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (response.ok === false) {
    throw new Error(`Couldn't load ${url} (HTTP ${response.status}).`);
  }
  return response.text();
}

/** The media type of a GraphQL over SSE stream. */
const EVENT_STREAM = 'text/event-stream';
/** The event that carries one result. */
const NEXT_EVENT = 'next';
/** The event that ends the stream. */
const COMPLETE_EVENT = 'complete';
/** What an SSE event is called when it names nothing. */
const DEFAULT_EVENT = 'message';
/** Between two SSE events. */
const EVENT_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
/** Between two lines of one SSE event. */
const LINE_END = /\r\n|\n|\r/;
/** Where the statuses that blame the request start. */
const FIRST_CLIENT_ERROR = 400;
/** Where the statuses that blame the server start. */
const FIRST_SERVER_ERROR = 500;
/** The one status that blames the request yet says "later", not "fix it". */
const TOO_MANY_REQUESTS = 429;

/**
 * A stream that ended without completing, or could not start for a reason that may pass: the network, a server at
 * its limit, an upstream that failed. Trying again may work, unlike after a `RequestError`, which the request caused.
 */
export class StreamDroppedError extends Error {
  override name = 'StreamDroppedError';
}

/** What `streamGraphQL` calls as the stream goes. */
export interface StreamHandlers<T> {
  /** Called once the server starts streaming. */
  onOpen: () => void;
  /** Called with each result, `errors` included: a result with errors does not end the stream. */
  onNext: (result: GraphQLResponse<T>) => void;
}

/**
 * Reads one SSE event's name and data.
 *
 * @param block - The event's lines.
 * @returns The name and the data lines joined, or null for a keep-alive comment.
 */
function sseEventOf(block: string): { event: string; data: string } | null {
  let event = DEFAULT_EVENT;
  const data: string[] = [];
  for (const line of block.split(LINE_END)) {
    const colon = line.indexOf(':');
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
 * Says why something failed, from any caught value.
 *
 * @param error - The caught value.
 * @returns Its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens one subscription through an upstream's proxy path, in GraphQL over SSE's "distinct connections" mode, and
 * hands each result over as it arrives.
 *
 * @typeParam T - What each result's `data` holds.
 * @param endpoint - The proxy path, on this origin.
 * @param operation - The subscription, its variables and its operation name.
 * @param handlers - What to call when the stream opens and on each result.
 * @param signal - Aborting it closes the stream.
 * @returns Once the server completes the stream.
 * @throws A `RequestError` when the server refused the subscription (fix it; don't retry), a `StreamDroppedError`
 * when the stream dropped or could not start (retry), and the abort reason when `signal` aborts.
 */
export async function streamGraphQL<T>(
  endpoint: string,
  operation: GraphQLOperation,
  handlers: StreamHandlers<T>,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: EVENT_STREAM },
      body: JSON.stringify(operation),
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new StreamDroppedError(`Couldn't reach Symphony: ${messageOf(error)}`);
  }
  const isStream = (response.headers.get('content-type') ?? '').startsWith(EVENT_STREAM);
  if (isStream === false || response.body === null) {
    const body = await readBody<T>(response);
    const refusal = new RequestError(
      body.errors ?? [{ message: `The server did not stream (HTTP ${response.status}).` }],
    );
    const isClientError =
      response.status >= FIRST_CLIENT_ERROR &&
      response.status < FIRST_SERVER_ERROR &&
      response.status !== TOO_MANY_REQUESTS;
    throw isClientError ? refusal : new StreamDroppedError(refusal.message);
  }
  handlers.onOpen();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    for (let read = await reader.read(); read.done === false; read = await reader.read()) {
      const blocks = (pending + read.value).split(EVENT_BOUNDARY);
      pending = blocks.pop() ?? '';
      for (const block of blocks) {
        const event = sseEventOf(block);
        if (event?.event === COMPLETE_EVENT) {
          return;
        }
        if (event?.event === NEXT_EVENT) {
          handlers.onNext(JSON.parse(event.data) as GraphQLResponse<T>);
        }
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    throw new StreamDroppedError(`The stream broke: ${messageOf(error)}`);
  } finally {
    void reader.cancel().catch(() => {});
  }
  signal.throwIfAborted();
  throw new StreamDroppedError('The stream closed before it completed.');
}
