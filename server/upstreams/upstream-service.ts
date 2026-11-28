// The upstream APIs Symphony wraps: their rows, their cached schemas, and every request sent to them.
// Introspection and proxying share one sender, so headers, secrets, timeouts and size limits are applied
// the same way to both.
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  buildClientSchema,
  type DocumentNode,
  GraphQLError,
  getIntrospectionQuery,
  getOperationAST,
  type IntrospectionQuery,
  OperationTypeNode,
  parse,
  printSchema,
  validate,
} from 'graphql';
import { UUID_PATTERN } from '../core/consts.ts';
import { UPSTREAM_DEFAULTS, type UpstreamSettings } from '../core/defaults.ts';
import { badInput, conflict, ErrorCode, errorMessage, notFound, upstreamFailed } from '../core/errors.ts';
import type { EventFeed } from '../core/events.ts';
import {
  type CachedSchema,
  type GraphQLRequest,
  type GraphQLResponseBody,
  type SubscribeOptions,
  type Upstream,
  UpstreamChange,
  type UpstreamEvent,
  type UpstreamInput,
  type UpstreamService,
  type UpstreamStream,
} from '../core/services.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { Database } from '../db/client.ts';
import { modules, moduleUpstreams, upstreamSchemas, upstreams } from '../db/schema.ts';
import { CONCEPT_SOURCE_NAME } from '../gateway/wiring.ts';
import { createSecretResolver, type SecretResolver } from './secrets.ts';
import { EVENT_STREAM, readServerSentEvents, SseEvent } from './sse.ts';

/** A header name as HTTP allows it. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Names are short labels an agent types. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
const MAX_NAME_CHARS = 60;
const ALLOWED_PROTOCOLS = ['http:', 'https:'];
/** How much of a non-JSON answer an error quotes, so the reader can tell an HTML error page from a proxy's. */
const NOT_JSON_PREVIEW_CHARS = 200;
/** Postgres' unique-violation code. */
const UNIQUE_VIOLATION = '23505';

/** What the service talks to. Tests pass PGlite and the fixture's fetch. */
export interface UpstreamServiceDeps {
  db: Database;
  /** How requests leave. Default: the global fetch. */
  fetch?: typeof fetch;
  /** Where `${env:…}` references are read. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Told after every add, update, remove and successful refresh, once the write is done. */
  events?: EventFeed<UpstreamEvent>;
}

/** One row of `upstreams` joined with its schema row. */
type UpstreamRow = typeof upstreams.$inferSelect;
type SchemaRow = typeof upstreamSchemas.$inferSelect;

/**
 * Checks and tidies what a person or agent typed.
 *
 * @param input - Name, URL and headers.
 * @returns The same, trimmed.
 * @throws BAD_USER_INPUT naming the first problem.
 */
function cleanInput(input: UpstreamInput): UpstreamInput {
  const name = input.name.trim();
  const isNameValid = NAME_PATTERN.test(name) && name.length <= MAX_NAME_CHARS;
  if (isNameValid === false) {
    throw badInput(
      `An upstream's name is 1–${MAX_NAME_CHARS} letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.`,
    );
  }
  if (name === CONCEPT_SOURCE_NAME) {
    throw badInput(
      `"${CONCEPT_SOURCE_NAME}" is the unified gateway's name for the concept subgraph; pick another name.`,
    );
  }
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw badInput(
      `"${input.url}" is not a URL. Give the full address of the GraphQL endpoint, with http:// or https://.`,
    );
  }
  if (ALLOWED_PROTOCOLS.includes(url.protocol) === false) {
    throw badInput('An upstream URL must start with http:// or https://.');
  }
  const headers = input.headers.map((header) => ({ name: header.name.trim(), value: header.value }));
  const badHeader = headers.find((header) => HEADER_NAME.test(header.name) === false);
  if (badHeader !== undefined) {
    throw badInput(`"${badHeader.name}" is not a valid header name.`);
  }
  return { name, url: url.toString(), headers };
}

/**
 * Whether a caught database error is a unique violation.
 *
 * @param error - The caught value, which drivers may wrap.
 * @returns True for a unique violation.
 */
function isUniqueViolation(error: unknown): boolean {
  const codeOf = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined;
  const cause = error instanceof Error ? error.cause : undefined;
  return codeOf(error) === UNIQUE_VIOLATION || codeOf(cause) === UNIQUE_VIOLATION;
}

/**
 * Hashes an SDL.
 *
 * @param sdl - The printed schema.
 * @returns Its sha256, in hex.
 */
function hashOf(sdl: string): string {
  return createHash('sha256').update(sdl).digest('hex');
}

/**
 * Reads a response body as text, refusing one over the limit.
 *
 * @param response - The upstream's response.
 * @param maxBytes - The largest body read.
 * @returns The body.
 * @throws UPSTREAM_FAILED when it is larger.
 */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    throw upstreamFailed(`The upstream's answer is ${declared} bytes, over the ${maxBytes}-byte limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw upstreamFailed(`The upstream's answer is over the ${maxBytes}-byte limit.`);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Turns an error into the body a GraphQL client expects.
 *
 * @param message - What went wrong.
 * @param code - The `extensions.code`.
 * @returns A body with one error and no data.
 */
export function errorBody(message: string, code: string): GraphQLResponseBody {
  return { errors: [{ message, extensions: { code } }] };
}

/** How a request travels through the proxy: one JSON answer, or a stream of events. */
export const ProxyTransport = {
  /** A query or a mutation, answered once. */
  Json: 'json',
  /** A subscription, streamed over SSE. */
  Stream: 'stream',
} as const;
export type ProxyTransport = (typeof ProxyTransport)[keyof typeof ProxyTransport];

/**
 * Whether the operation a request runs is a subscription.
 *
 * @param document - The parsed document.
 * @param [operationName] - Which operation runs, when the document holds several.
 * @returns True for a subscription. False when it is not one, or the operation can't be picked out (validation, or
 * the upstream, reports that).
 */
export function isSubscription(document: DocumentNode, operationName?: string | null): boolean {
  return getOperationAST(document, operationName ?? undefined)?.operation === OperationTypeNode.SUBSCRIPTION;
}

/**
 * Whether a request's operation is a subscription, without validating it.
 *
 * @param request - The request.
 * @returns True for a subscription. False for anything else, a document that doesn't parse among them: the JSON path
 * reports that.
 */
export function isSubscriptionRequest(request: GraphQLRequest): boolean {
  try {
    return isSubscription(parse(request.query), request.operationName);
  } catch {
    return false;
  }
}

/**
 * Refuses a subscription that arrived as plain JSON, which can't carry a stream.
 *
 * @param document - The parsed, valid document.
 * @param request - The request.
 * @param transport - How it arrived.
 * @returns A body saying how to send it, or null when it may go on.
 */
function transportRefusalOf(
  document: DocumentNode,
  request: GraphQLRequest,
  transport: ProxyTransport,
): GraphQLResponseBody | null {
  const isStreamedOverJson = transport === ProxyTransport.Json && isSubscription(document, request.operationName);
  if (isStreamedOverJson) {
    return errorBody(
      `This is a subscription, which streams. Post it with \`accept: ${EVENT_STREAM}\` (a module's useSubscription does).`,
      ErrorCode.BadUserInput,
    );
  }
  return null;
}

/**
 * Checks one request against an upstream's cached schema before it is sent.
 *
 * @param name - The upstream's name, for the message.
 * @param schema - Its cached schema; null when it was never fetched.
 * @param request - The request.
 * @param [transport] - How it arrived: a subscription sent as JSON is refused.
 * @returns A body with the problems, or null when the request may be sent.
 */
export function refusalOf(
  name: string,
  schema: CachedSchema | null,
  request: GraphQLRequest,
  transport: ProxyTransport = ProxyTransport.Json,
): GraphQLResponseBody | null {
  if (schema === null) {
    return errorBody(
      `${name}'s schema has not been fetched, so the request can't be checked. Refresh its schema first.`,
      ErrorCode.UpstreamFailed,
    );
  }
  let document: ReturnType<typeof parse>;
  try {
    document = parse(request.query);
  } catch (error) {
    return errorBody(errorMessage(error), ErrorCode.BadUserInput);
  }
  const problems = validate(schema.schema, document);
  if (problems.length === 0) {
    return transportRefusalOf(document, request, transport);
  }
  return {
    errors: problems.map((problem) => ({ ...problem.toJSON(), extensions: { code: ErrorCode.BadUserInput } })),
  };
}

/**
 * Reads one `next` event's data as an execution result.
 *
 * @param upstream - The upstream, for the message.
 * @param upstream.name - Its name.
 * @param data - The event's data.
 * @param secrets - Redacts the message.
 * @returns The result.
 * @throws UPSTREAM_FAILED when it is not JSON.
 */
function parseEvent(upstream: { name: string }, data: string, secrets: SecretResolver): GraphQLResponseBody {
  try {
    return JSON.parse(data) as GraphQLResponseBody;
  } catch {
    throw upstreamFailed(
      secrets.redact(`${upstream.name} sent an event that is not JSON: ${data.slice(0, NOT_JSON_PREVIEW_CHARS)}`),
    );
  }
}

/** A schema as the cache keeps it, without when it was fetched. */
export type DescribedSchema = Omit<CachedSchema, 'fetchedAt'>;

/**
 * Builds a schema from an introspection result and describes it the way the cache stores it.
 *
 * @param introspection - The `data` of an introspection query.
 * @returns The schema, its SDL, the SDL's hash and its type count (`__` types left out).
 * @throws When the introspection is not a usable schema.
 */
export function describeIntrospection(introspection: IntrospectionQuery): DescribedSchema {
  const schema = buildClientSchema(introspection);
  const sdl = printSchema(schema);
  const typeCount = Object.keys(schema.getTypeMap()).filter((name) => name.startsWith('__') === false).length;
  return { schema, sdl, hash: hashOf(sdl), typeCount };
}

/**
 * Builds the upstream service.
 *
 * @param deps - The database, and the fetch and environment requests use.
 * @param [overrides] - Upstream settings to replace.
 * @returns The service.
 */
export function createUpstreamService(
  deps: UpstreamServiceDeps,
  overrides: Partial<UpstreamSettings> = {},
): UpstreamService {
  const settings = { ...UPSTREAM_DEFAULTS, ...overrides };
  const { db } = deps;
  const send = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  /**
   * Tells the listeners about a change to one upstream.
   *
   * @param change - What happened.
   * @param upstream - The upstream as it is now.
   * @param [previousName] - Its name before the change, when an update renamed it.
   */
  const announce = async (change: UpstreamChange, upstream: Upstream, previousName = upstream.name) => {
    await deps.events?.emit({ change, id: upstream.id, name: upstream.name, previousName });
    return upstream;
  };
  /** Schemas rebuilt from stored introspection, by upstream id and hash, so a request doesn't rebuild one. */
  const built = new Map<string, CachedSchema>();

  /**
   * Rebuilds (or reuses) the schema a stored row describes.
   *
   * @param row - The schema row.
   * @returns The cached schema.
   */
  const cachedSchemaOf = (row: SchemaRow): CachedSchema => {
    const known = built.get(row.upstreamId);
    if (known !== undefined && known.hash === row.hash) {
      return known;
    }
    const schema = buildClientSchema(row.introspection as IntrospectionQuery);
    const cached: CachedSchema = {
      schema,
      sdl: row.sdl,
      hash: row.hash,
      typeCount: row.typeCount,
      fetchedAt: row.fetchedAt,
    };
    built.set(row.upstreamId, cached);
    return cached;
  };

  /**
   * Joins an upstream row with its schema.
   *
   * @param row - The upstream row.
   * @returns The upstream.
   */
  const toUpstream = async (row: UpstreamRow): Promise<Upstream> => {
    const [schemaRow] = await db.select().from(upstreamSchemas).where(eq(upstreamSchemas.upstreamId, row.id));
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      headers: row.headers,
      schema: schemaRow === undefined ? null : cachedSchemaOf(schemaRow),
    };
  };

  /**
   * Finds an upstream row by id or name.
   *
   * @param idOrName - Either.
   * @returns The row, or undefined.
   */
  const findRow = async (idOrName: string): Promise<UpstreamRow | undefined> => {
    const isId = UUID_PATTERN.test(idOrName);
    const column = isId ? upstreams.id : upstreams.name;
    const [row] = await db.select().from(upstreams).where(eq(column, idOrName));
    return row;
  };

  /**
   * Finds an upstream row, or refuses.
   *
   * @param idOrName - Either.
   * @returns The row.
   * @throws NOT_FOUND.
   */
  const requireRow = async (idOrName: string): Promise<UpstreamRow> => {
    const row = await findRow(idOrName);
    if (row === undefined) {
      throw notFound(`There is no upstream "${idOrName}". Call list_upstreams for their names.`);
    }
    return row;
  };

  /**
   * Builds the headers of one request to an upstream: its stored ones, with their secrets filled in.
   *
   * @param row - The upstream.
   * @param secrets - Fills in `${env:…}` references.
   * @param accept - What answer the request takes.
   * @returns The headers.
   */
  const headersFor = (row: UpstreamRow, secrets: SecretResolver, accept: string): Headers => {
    const headers = new Headers({ 'content-type': 'application/json', accept });
    for (const header of row.headers) {
      headers.set(header.name, secrets.resolve(header.value));
    }
    return headers;
  };

  /**
   * Sends one GraphQL request to an upstream with its headers.
   *
   * @param row - The upstream.
   * @param request - The request.
   * @param timeoutMs - How long it may take.
   * @returns The parsed response body.
   * @throws UPSTREAM_FAILED for a network failure, a timeout, a non-2xx answer or one that is not JSON.
   */
  const sendRequest = async (
    row: UpstreamRow,
    request: GraphQLRequest,
    timeoutMs: number,
  ): Promise<GraphQLResponseBody> => {
    const secrets = createSecretResolver(env, settings.secretEnvPrefix);
    let response: Response;
    try {
      response = await send(row.url, {
        method: 'POST',
        headers: headersFor(row, secrets, 'application/json'),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw upstreamFailed(secrets.redact(`Could not reach ${row.name} at ${row.url}: ${errorMessage(error)}`));
    }
    return readGraphQLBody(row, response, secrets);
  };

  /**
   * Reads an upstream's answer as a GraphQL response body.
   *
   * @param row - The upstream, for the messages.
   * @param response - Its answer.
   * @param secrets - Redacts the messages.
   * @returns The parsed body.
   * @throws UPSTREAM_FAILED when it is too large, not JSON, or JSON without data or errors.
   */
  const readGraphQLBody = async (
    row: UpstreamRow,
    response: Response,
    secrets: SecretResolver,
  ): Promise<GraphQLResponseBody> => {
    const text = await readLimited(response, settings.maxResponseBytes);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw upstreamFailed(
        secrets.redact(
          `${row.name} answered HTTP ${response.status} with something that is not JSON: ${text.slice(0, NOT_JSON_PREVIEW_CHARS)}`,
        ),
      );
    }
    const isGraphQLBody = typeof body === 'object' && body !== null && ('data' in body || 'errors' in body);
    if (isGraphQLBody === false) {
      throw upstreamFailed(`${row.name} answered HTTP ${response.status} without data or errors.`);
    }
    return body as GraphQLResponseBody;
  };

  /**
   * Opens one subscription on an upstream over SSE, with its headers. The proxy timeout covers only the wait for the
   * upstream to start answering; after that the stream lasts until it completes or `options.signal` aborts.
   *
   * @param row - The upstream.
   * @param request - The subscription, already validated.
   * @param options - The signal that closes it, and the largest event read.
   * @returns The open stream, or the upstream's own refusal when it answered without streaming.
   * @throws UPSTREAM_FAILED for a network failure, a timeout, or an answer that is neither a stream nor GraphQL.
   */
  const openStream = async (
    row: UpstreamRow,
    request: GraphQLRequest,
    options: SubscribeOptions,
  ): Promise<UpstreamStream> => {
    const secrets = createSecretResolver(env, settings.secretEnvPrefix);
    const starting = new AbortController();
    const startTimer = setTimeout(
      () => starting.abort(new Error(`no answer within ${settings.proxyTimeoutMs / MS_PER_SECOND} s`)),
      settings.proxyTimeoutMs,
    );
    let response: Response;
    try {
      response = await send(row.url, {
        method: 'POST',
        headers: headersFor(row, secrets, EVENT_STREAM),
        body: JSON.stringify(request),
        signal: AbortSignal.any([options.signal, starting.signal]),
      });
    } catch (error) {
      throw upstreamFailed(secrets.redact(`Could not reach ${row.name} at ${row.url}: ${errorMessage(error)}`));
    } finally {
      clearTimeout(startTimer);
    }
    const isStream = response.ok && (response.headers.get('content-type') ?? '').startsWith(EVENT_STREAM);
    if (isStream === false || response.body === null) {
      return { isOpen: false, body: await readGraphQLBody(row, response, secrets) };
    }
    return { isOpen: true, events: streamEvents(row, response.body, options, secrets) };
  };

  /**
   * Follows an upstream's stream, yielding each `next` result.
   *
   * @param row - The upstream, for the messages.
   * @param body - The stream. Leaving the loop early cancels it, which closes the upstream connection.
   * @param options - The largest event read, and the signal that closes the stream.
   * @param secrets - Redacts the messages.
   * @returns The results, ending when the upstream sends `complete`.
   * @throws UPSTREAM_FAILED when the stream ends without `complete`, fails, or carries an event that is too large or
   * not JSON.
   */
  async function* streamEvents(
    row: UpstreamRow,
    body: ReadableStream<Uint8Array>,
    options: SubscribeOptions,
    secrets: SecretResolver,
  ): AsyncGenerator<GraphQLResponseBody> {
    try {
      for await (const event of readServerSentEvents(body, options)) {
        if (event.event === SseEvent.Complete) {
          return;
        }
        if (event.event === SseEvent.Next) {
          yield parseEvent(row, event.data, secrets);
        }
      }
    } catch (error) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw upstreamFailed(secrets.redact(`${row.name}'s stream failed: ${errorMessage(error)}`));
    }
    throw upstreamFailed(`${row.name} closed the stream without completing it.`);
  }

  return {
    list: async () => {
      const rows = await db.select().from(upstreams).orderBy(upstreams.name);
      return Promise.all(rows.map(toUpstream));
    },

    find: async (idOrName) => {
      const row = await findRow(idOrName);
      return row === undefined ? null : toUpstream(row);
    },

    add: async (input) => {
      const clean = cleanInput(input);
      let row: UpstreamRow | undefined;
      try {
        [row] = await db.insert(upstreams).values(clean).returning();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(`An upstream named "${clean.name}" already exists.`);
        }
        throw error;
      }
      if (row === undefined) {
        throw new Error('The upstream insert returned no row.');
      }
      let added: Upstream;
      try {
        added = await refreshRow(row);
      } catch (error) {
        console.warn(`[upstreams] ${row.name}: first introspection failed: ${errorMessage(error)}`);
        added = await toUpstream(row);
      }
      return announce(UpstreamChange.Added, added);
    },

    update: async (id, input) => {
      const existing = await requireRow(id);
      const clean = cleanInput(input);
      let updated: Upstream;
      try {
        const [row] = await db.update(upstreams).set(clean).where(eq(upstreams.id, existing.id)).returning();
        updated = await toUpstream(row ?? existing);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(`An upstream named "${clean.name}" already exists.`);
        }
        throw error;
      }
      return announce(UpstreamChange.Updated, updated, existing.name);
    },

    remove: async (id) => {
      const row = await findRow(id);
      if (row === undefined) {
        return false;
      }
      // Modules list their upstreams without a foreign key (the built-in unified upstream has no row), so every module
      // that lists this one, in any position, goes here.
      await db.transaction(async (tx) => {
        const listing = tx
          .select({ moduleId: moduleUpstreams.moduleId })
          .from(moduleUpstreams)
          .where(eq(moduleUpstreams.upstreamId, row.id));
        await tx.delete(modules).where(inArray(modules.id, listing));
        await tx.delete(upstreams).where(eq(upstreams.id, row.id));
      });
      built.delete(row.id);
      await deps.events?.emit({ change: UpstreamChange.Removed, id: row.id, name: row.name, previousName: row.name });
      return true;
    },

    refresh: async (id) => announce(UpstreamChange.Refreshed, await refreshRow(await requireRow(id))),

    subscribe: async (id, request, options) => {
      const row = await requireRow(id);
      const upstream = await toUpstream(row);
      const refusal = refusalOf(row.name, upstream.schema, request, ProxyTransport.Stream);
      if (refusal !== null) {
        return { isOpen: false, body: refusal };
      }
      try {
        return await openStream(row, request, options);
      } catch (error) {
        const code = error instanceof GraphQLError ? String(error.extensions.code) : ErrorCode.UpstreamFailed;
        return { isOpen: false, body: errorBody(errorMessage(error), code) };
      }
    },

    execute: async (id, request) => {
      const row = await requireRow(id);
      const upstream = await toUpstream(row);
      const refusal = refusalOf(row.name, upstream.schema, request);
      if (refusal !== null) {
        return refusal;
      }
      try {
        return await sendRequest(row, request, settings.proxyTimeoutMs);
      } catch (error) {
        const code = error instanceof GraphQLError ? String(error.extensions.code) : ErrorCode.UpstreamFailed;
        return errorBody(errorMessage(error), code);
      }
    },
  };

  /**
   * Introspects one upstream and stores what it answered.
   *
   * @param row - The upstream.
   * @returns The upstream with its new schema.
   * @throws UPSTREAM_FAILED when the upstream can't be reached or its answer is not a schema.
   */
  async function refreshRow(row: UpstreamRow): Promise<Upstream> {
    const query = getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true });
    const body = await sendRequest(row, { query }, settings.introspectionTimeoutMs);
    const hasErrors = (body.errors?.length ?? 0) > 0;
    if (hasErrors || body.data === undefined || body.data === null) {
      const messages = body.errors?.map((error) => error.message).join(' ') ?? 'no data';
      throw upstreamFailed(`${row.name} refused introspection: ${messages}`);
    }
    const introspection = body.data as IntrospectionQuery;
    let described: DescribedSchema;
    try {
      described = describeIntrospection(introspection);
    } catch (error) {
      throw upstreamFailed(`${row.name}'s introspection is not a usable schema: ${errorMessage(error)}`);
    }
    const { sdl, hash, typeCount } = described;
    const values = { upstreamId: row.id, introspection, sdl, hash, typeCount, fetchedAt: new Date() };
    await db
      .insert(upstreamSchemas)
      .values(values)
      .onConflictDoUpdate({ target: upstreamSchemas.upstreamId, set: values });
    console.log(`[upstreams] ${row.name}: schema fetched, ${typeCount} types`);
    return toUpstream(row);
  }
}
