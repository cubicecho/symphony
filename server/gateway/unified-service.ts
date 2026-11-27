// The unified gateway as a Symphony feature: every upstream with a cached schema and the servable concepts, composed
// into one supergraph and served by one Hive Gateway runtime that is hot-swapped on every change.
//
// Changes (a concept, an override, an upstream) ask for a recompose; requests arriving within the debounce are
// coalesced, and compositions never overlap. A failed composition keeps the last good supergraph serving.
// The served schema is introspected in-process after each composition, so the built-in `unified` upstream
// (unified-upstream.ts) can hand it out and validate against it like any cached upstream schema.
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestHandler } from 'express';
import { type GraphQLSchema, getIntrospectionQuery, type IntrospectionQuery } from 'graphql';
import type { Concept } from '../concepts/concept.ts';
import { ConceptValidationError, createConceptSubgraph } from '../concepts/subgraph.ts';
import { GATEWAY_DEFAULTS, type GatewaySettings, UPSTREAM_DEFAULTS } from '../core/defaults.ts';
import { ErrorCode, errorMessage } from '../core/errors.ts';
import type { EventFeed } from '../core/events.ts';
import {
  type CachedSchema,
  type ConceptService,
  type GraphQLRequest,
  type GraphQLResponseBody,
  type SourcesChange,
  type UnifiedError,
  type UnifiedProblem,
  UnifiedProblemKind,
  type UnifiedService,
  UnifiedState,
  type UnifiedStatus,
  type Upstream,
  type UpstreamEvent,
  type UpstreamService,
  type WiringService,
} from '../core/services.ts';
import { HttpStatus } from '../core/wire.ts';
import { createSecretResolver } from '../upstreams/secrets.ts';
import { describeIntrospection, errorBody } from '../upstreams/upstream-service.ts';
import { type CompositionIssue, composeSupergraph, type Supergraph, SupergraphCompositionError } from './compose.ts';
import { schemasByName } from './concept-service.ts';
import { createUnifiedGateway, type UnifiedGateway } from './gateway.ts';
import type { Source } from './sources.ts';
import { CONCEPT_SOURCE_NAME, type EffectiveWiring } from './wiring.ts';

/** The log tag. */
const LOG_TAG = '[gateway]';

/** Where the app serves the unified API, beside the admin API's /graphql. */
export const UNIFIED_ENDPOINT = '/unified/graphql';

/** What the unified service reads, follows and sends through. */
export interface UnifiedServiceDeps {
  upstreams: UpstreamService;
  concepts: ConceptService;
  wiring: WiringService;
  /** Concept and override changes, each asking for a recompose. */
  changes?: EventFeed<SourcesChange>;
  /** Upstream changes, each asking for a recompose. */
  upstreamEvents?: EventFeed<UpstreamEvent>;
  /** How the gateway reaches upstreams. Default: the global fetch. */
  fetch?: typeof fetch;
  /** Where header `${env:…}` references are read. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The path the gateway answers on, as mounted. Default: UNIFIED_ENDPOINT. */
  graphqlEndpoint?: string;
  /** Told the new served schema whenever a composition changes its SDL, before that composition counts as done. */
  servedSchemas?: EventFeed<CachedSchema>;
}

/** The unified gateway with what the app and boot need besides its status. */
export interface UnifiedGatewayService extends UnifiedService {
  /** Starts the first composition in the background; changes recompose from then on. */
  start(): void;
  /**
   * Asks for a recompose, coalesced with any asked for within the debounce.
   *
   * @param reason - For the log.
   */
  requestRecompose(reason: string): void;
  /** Resolves once no composition is waiting or running. */
  whenIdle(): Promise<void>;
  /** The schema being served, as introspected from it; null until the first composition succeeds. */
  servedSchema(): CachedSchema | null;
  /**
   * Runs one request on the served supergraph in-process, through the gateway runtime, with no HTTP round trip.
   * It is not validated here: the unified upstream does that against `servedSchema`.
   *
   * @param request - The request.
   * @returns The response body; a body with `errors` while nothing is served.
   */
  execute(request: GraphQLRequest): Promise<GraphQLResponseBody>;
  /** Serves the gateway: 503 until the first composition succeeds. Mount it behind express.json. */
  handler: RequestHandler;
  /** Stops recomposing and closes the gateway. */
  dispose(): Promise<void>;
}

/** What one attempt built: the sources to compose, and what was left out on the way. */
interface Assembly {
  sources: Source[];
  problems: UnifiedProblem[];
}

/** Where in-process requests are addressed: the runtime routes on the path only, so the host is never reached. */
const IN_PROCESS_ORIGIN = 'http://unified.internal';

/** A GraphQL name, which a subgraph name must be to appear in the supergraph as it is. */
const GRAPHQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What a character a GraphQL name can't hold becomes in a subgraph name. */
const NAME_FILLER = '_';
/** Prefixed to a subgraph name that would otherwise start with a digit. */
const NAME_PREFIX = 'u_';

/**
 * Names a subgraph after a Symphony source, deterministically: a GraphQL name stays as it is, anything else has its
 * other characters replaced, and a clash with a name already taken gets a numbered suffix.
 *
 * @param name - The upstream's (or the concept subgraph's) name.
 * @param taken - Subgraph names given so far; this adds to it.
 * @returns The subgraph name.
 */
function subgraphNameOf(name: string, taken: Set<string>): string {
  const filled = name.replace(/[^A-Za-z0-9_]/g, NAME_FILLER);
  const base = GRAPHQL_NAME.test(filled) ? filled : `${NAME_PREFIX}${filled}`;
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base}_${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Turns a concept problem into a unified one.
 *
 * @param problem - From validateConcepts or ConceptValidationError.
 * @returns The same, as the status lists it.
 */
function conceptProblem(problem: ConceptValidationError['problems'][number]): UnifiedProblem {
  return {
    kind: UnifiedProblemKind.Concept,
    source: problem.member,
    concept: problem.concept,
    operation: problem.operation,
    message: problem.message,
    line: problem.line,
    column: problem.column,
  };
}

/**
 * Makes a problem about one source as a whole.
 *
 * @param kind - Wiring or source.
 * @param source - The source's name.
 * @param message - What is wrong.
 * @param [concept] - The concept it came from, when one.
 * @returns The problem.
 */
function sourceProblem(kind: UnifiedProblemKind, source: string, message: string, concept: string | null = null) {
  return { kind, source, concept, operation: null, message, line: null, column: null };
}

/**
 * Builds the unified gateway service. Nothing is composed until `start`.
 *
 * @param deps - The services it composes from, the feeds it follows, and how it reaches upstreams.
 * @param [overrides] - Gateway settings to replace.
 * @returns The service.
 */
export function createUnifiedService(
  deps: UnifiedServiceDeps,
  overrides: Partial<GatewaySettings> = {},
): UnifiedGatewayService {
  const settings = { ...GATEWAY_DEFAULTS, ...overrides };
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const graphqlEndpoint = deps.graphqlEndpoint ?? UNIFIED_ENDPOINT;

  let gateway: UnifiedGateway | null = null;
  let served: CachedSchema | null = null;
  let status: UnifiedStatus = {
    state: UnifiedState.Starting,
    composedAt: null,
    sources: [],
    problems: [],
    lastError: null,
  };
  /** Symphony's name for each subgraph of the served supergraph. */
  let sourceNames = new Map<string, string>();
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let isRerunAsked = false;
  let isStarted = false;
  let isDisposed = false;
  let reasons: string[] = [];

  /**
   * Describes one upstream as a gateway source, its secrets resolved here so they never leave the server.
   *
   * @param upstream - An upstream with a cached schema.
   * @param sdl - Its cached SDL.
   * @param wiring - Its effective wiring, when it has any.
   * @returns The source.
   * @throws UPSTREAM_FAILED naming a header secret that can't be resolved.
   */
  const upstreamSource = (upstream: Upstream, sdl: string, wiring: EffectiveWiring | undefined): Source => {
    const secrets = createSecretResolver(env, UPSTREAM_DEFAULTS.secretEnvPrefix);
    const headers = Object.fromEntries(upstream.headers.map((header) => [header.name, secrets.resolve(header.value)]));
    return {
      kind: 'graphql',
      name: upstream.name,
      endpoint: upstream.url,
      sdl,
      headers,
      ...(wiring === undefined ? {} : { renames: wiring.renames, mergeKeys: wiring.mergeKeys }),
    };
  };

  /**
   * Builds the concept subgraph's source over the servable concepts.
   *
   * @param concepts - Concepts with no problems.
   * @param upstreams - Every upstream; requests go to them by id.
   * @param schemas - Their schemas, by name.
   * @param wiring - The concept subgraph's effective wiring, when it has any.
   * @returns The source.
   * @throws ConceptValidationError when the concepts can't be served together.
   */
  const conceptSource = (
    concepts: Concept[],
    upstreams: readonly Upstream[],
    schemas: ReadonlyMap<string, GraphQLSchema>,
    wiring: EffectiveWiring | undefined,
  ): Source => {
    const idsByName = new Map(upstreams.map((upstream) => [upstream.name, upstream.id]));
    const schema = createConceptSubgraph(concepts, schemas, (name, request) =>
      deps.upstreams.execute(idsByName.get(name) ?? name, request),
    );
    return {
      kind: 'schema',
      name: CONCEPT_SOURCE_NAME,
      schema,
      ...(wiring === undefined ? {} : { renames: wiring.renames, mergeKeys: wiring.mergeKeys }),
    };
  };

  /**
   * Reads everything a composition needs and builds its sources.
   *
   * @returns The sources, by Symphony name, and what was left out.
   */
  const assemble = async (): Promise<Assembly> => {
    const [upstreams, records, wiringState] = await Promise.all([
      deps.upstreams.list(),
      deps.concepts.list(),
      deps.wiring.effective(),
    ]);
    const wiringOf = (name: string) => wiringState.wiring.find((one) => one.upstream === name);
    const problems: UnifiedProblem[] = [
      ...records.flatMap((record) => record.problems.map(conceptProblem)),
      ...wiringState.problems.map((problem) =>
        sourceProblem(UnifiedProblemKind.Wiring, problem.upstream, problem.message, problem.concept),
      ),
    ];
    const sources: Source[] = [];
    for (const upstream of upstreams) {
      if (upstream.schema === null) {
        continue;
      }
      try {
        sources.push(upstreamSource(upstream, upstream.schema.sdl, wiringOf(upstream.name)));
      } catch (error) {
        problems.push(sourceProblem(UnifiedProblemKind.Source, upstream.name, errorMessage(error)));
      }
    }
    const servable = records.flatMap((record) =>
      record.concept !== null && record.problems.length === 0 ? [record.concept] : [],
    );
    if (servable.length > 0) {
      try {
        sources.push(conceptSource(servable, upstreams, schemasByName(upstreams), wiringOf(CONCEPT_SOURCE_NAME)));
      } catch (error) {
        if (error instanceof ConceptValidationError === false) {
          throw error;
        }
        problems.push(...error.problems.map(conceptProblem));
      }
    }
    return { sources, problems };
  };

  /**
   * Composes and swaps once, recording how it went.
   *
   * @param why - What asked for it, for the log.
   */
  const composeOnce = async (why: string): Promise<void> => {
    let problems: UnifiedProblem[] = [];
    let names = new Map<string, string>();
    try {
      const assembly = await assemble();
      problems = assembly.problems;
      if (assembly.sources.length === 0) {
        throw new Error('There is nothing to compose: no upstream has a cached schema, and no concept can be served.');
      }
      const taken = new Set<string>();
      const sources = assembly.sources.map((source) => ({ ...source, name: subgraphNameOf(source.name, taken) }));
      names = new Map(sources.map((source, index) => [source.name, assembly.sources[index]?.name ?? source.name]));
      const supergraph: Supergraph = await composeSupergraph(sources, { fetch: fetchFn });
      if (gateway === null) {
        gateway = createUnifiedGateway({
          supergraph,
          fetch: fetchFn,
          graphqlEndpoint,
        });
        await gateway.runtime.getSchema();
      } else {
        await gateway.swap(supergraph);
      }
      sourceNames = names;
      status = {
        state: UnifiedState.Ready,
        composedAt: new Date(),
        sources: sources.map((source) => ({ name: sourceNames.get(source.name) ?? source.name, kind: source.kind })),
        problems,
        lastError: null,
      };
      console.log(LOG_TAG, `composed ${sources.length} source(s) (${why})`);
    } catch (error) {
      recordFailure(error, why, names, problems);
      return;
    }
    await introspectServed(why);
  };

  /**
   * Records a failed composition; the last good supergraph, if any, keeps serving.
   *
   * @param error - What the attempt threw.
   * @param why - What asked for it, for the log.
   * @param names - Symphony's name for each subgraph the attempt named.
   * @param problems - What the attempt left out.
   */
  const recordFailure = (
    error: unknown,
    why: string,
    names: ReadonlyMap<string, string>,
    problems: UnifiedProblem[],
  ): void => {
    const issues: CompositionIssue[] =
      error instanceof SupergraphCompositionError
        ? error.issues.map((issue) =>
            issue.source === undefined ? issue : { ...issue, source: names.get(issue.source) ?? issue.source },
          )
        : [];
    const lastError: UnifiedError = { message: errorMessage(error), issues, at: new Date() };
    const state = gateway === null ? UnifiedState.Failed : UnifiedState.Ready;
    status = { ...status, state, problems, lastError };
    console.warn(
      LOG_TAG,
      `composition failed (${why}); ${gateway === null ? 'nothing is served' : 'the last good supergraph keeps serving'}: ${lastError.message}`,
    );
  };

  /**
   * Sends one request to the served supergraph through the runtime's fetch handler.
   *
   * @param request - The request.
   * @returns The response body.
   */
  const executeInProcess = async (request: GraphQLRequest): Promise<GraphQLResponseBody> => {
    if (gateway === null) {
      return errorBody(
        "The unified API is not serving yet: no composition has succeeded. The admin API's unifiedStatus says why.",
        ErrorCode.UpstreamFailed,
      );
    }
    const response = await gateway.runtime.fetch(`${IN_PROCESS_ORIGIN}${graphqlEndpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    });
    return (await response.json()) as GraphQLResponseBody;
  };

  /**
   * Introspects what is now served and, when its SDL changed, keeps it and tells the followers. A failure keeps
   * the schema introspected before.
   *
   * @param why - What asked for the composition, for the log.
   */
  const introspectServed = async (why: string): Promise<void> => {
    let next: CachedSchema;
    try {
      const query = getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true });
      const body = await executeInProcess({ query });
      const hasErrors = (body.errors?.length ?? 0) > 0;
      if (hasErrors || body.data === undefined || body.data === null) {
        throw new Error(body.errors?.map((one) => one.message).join(' ') ?? 'no data');
      }
      next = { ...describeIntrospection(body.data as IntrospectionQuery), fetchedAt: new Date() };
    } catch (error) {
      console.warn(LOG_TAG, `could not introspect the served supergraph (${why}): ${errorMessage(error)}`);
      return;
    }
    if (served?.hash === next.hash) {
      return;
    }
    served = next;
    await deps.servedSchemas?.emit(next);
  };

  /** Runs a composition now, or once the running one is done. */
  const fire = (): void => {
    timer = null;
    if (running !== null) {
      isRerunAsked = true;
      return;
    }
    const why = reasons.length === 0 ? 'start' : [...new Set(reasons)].join(', ');
    reasons = [];
    running = composeOnce(why).finally(() => {
      running = null;
      if (isRerunAsked && isDisposed === false) {
        isRerunAsked = false;
        fire();
      }
    });
  };

  const requestRecompose = (reason: string): void => {
    const isListening = isStarted && isDisposed === false;
    if (isListening === false) {
      return;
    }
    reasons.push(reason);
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(fire, settings.recomposeDebounceMs);
    timer.unref();
  };

  deps.changes?.subscribe((change) => requestRecompose(change.reason));
  deps.upstreamEvents?.subscribe((event) => requestRecompose(`upstream ${event.name} ${event.change}`));

  return {
    status: () => status,

    start: () => {
      if (isStarted) {
        return;
      }
      isStarted = true;
      fire();
    },

    requestRecompose,

    servedSchema: () => served,

    execute: executeInProcess,

    whenIdle: async () => {
      while (timer !== null || running !== null) {
        await (running ?? delay(settings.recomposeDebounceMs));
      }
    },

    handler: (request, response) => {
      if (gateway === null) {
        const message =
          status.state === UnifiedState.Failed
            ? `The unified API is not available: ${status.lastError?.message ?? 'its composition failed.'} The admin API's unifiedStatus says more.`
            : 'The unified API is still starting: its first composition has not finished. Try again shortly.';
        response.status(HttpStatus.ServiceUnavailable).json({ errors: [{ message }] });
        return;
      }
      return gateway.runtime(request, response);
    },

    dispose: async () => {
      isDisposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await running;
      await gateway?.dispose();
    },
  };
}
