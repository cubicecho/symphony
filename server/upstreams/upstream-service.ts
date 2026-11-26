// The upstream APIs Symphony wraps: their rows, their cached schemas, and every request sent to them.
// Introspection and proxying share one sender, so headers, secrets, timeouts and size limits are applied
// the same way to both.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  buildClientSchema,
  GraphQLError,
  getIntrospectionQuery,
  type IntrospectionQuery,
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
  type Upstream,
  UpstreamChange,
  type UpstreamEvent,
  type UpstreamInput,
  type UpstreamService,
} from '../core/services.ts';
import type { Database } from '../db/client.ts';
import { upstreamSchemas, upstreams } from '../db/schema.ts';
import { CONCEPT_SOURCE_NAME } from '../gateway/wiring.ts';
import { createSecretResolver } from './secrets.ts';

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
function errorBody(message: string, code: string): GraphQLResponseBody {
  return { errors: [{ message, extensions: { code } }] };
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
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
    for (const header of row.headers) {
      headers.set(header.name, secrets.resolve(header.value));
    }
    let response: Response;
    try {
      response = await send(row.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw upstreamFailed(secrets.redact(`Could not reach ${row.name} at ${row.url}: ${errorMessage(error)}`));
    }
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
      await db.delete(upstreams).where(eq(upstreams.id, row.id));
      built.delete(row.id);
      await deps.events?.emit({ change: UpstreamChange.Removed, id: row.id, name: row.name, previousName: row.name });
      return true;
    },

    refresh: async (id) => announce(UpstreamChange.Refreshed, await refreshRow(await requireRow(id))),

    execute: async (id, request) => {
      const row = await requireRow(id);
      const upstream = await toUpstream(row);
      if (upstream.schema === null) {
        return errorBody(
          `${row.name}'s schema has not been fetched, so the request can't be checked. Refresh its schema first.`,
          ErrorCode.UpstreamFailed,
        );
      }
      let document: ReturnType<typeof parse>;
      try {
        document = parse(request.query);
      } catch (error) {
        return errorBody(errorMessage(error), ErrorCode.BadUserInput);
      }
      const problems = validate(upstream.schema.schema, document);
      if (problems.length > 0) {
        return {
          errors: problems.map((problem) => ({ ...problem.toJSON(), extensions: { code: ErrorCode.BadUserInput } })),
        };
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
    let sdl: string;
    let typeCount: number;
    try {
      const schema = buildClientSchema(introspection);
      sdl = printSchema(schema);
      typeCount = Object.keys(schema.getTypeMap()).filter((name) => name.startsWith('__') === false).length;
    } catch (error) {
      throw upstreamFailed(`${row.name}'s introspection is not a usable schema: ${errorMessage(error)}`);
    }
    const values = { upstreamId: row.id, introspection, sdl, hash: hashOf(sdl), typeCount, fetchedAt: new Date() };
    await db
      .insert(upstreamSchemas)
      .values(values)
      .onConflictDoUpdate({ target: upstreamSchemas.upstreamId, set: values });
    console.log(`[upstreams] ${row.name}: schema fetched, ${typeCount} types`);
    return toUpstream(row);
  }
}
