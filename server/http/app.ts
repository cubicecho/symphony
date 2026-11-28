import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoveryMiddleware } from '@cubicecho/mcp-discovery';
import express, { type Express } from 'express';
import { createYoga } from 'graphql-yoga';
import { createComponentCatalog } from '../catalog/catalog.ts';
import { isProduction, lanDiscover, subscriptionSettings, trustProxy, version } from '../core/config.ts';
import { HTTP_DEFAULTS, type SubscriptionSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { createEventFeed } from '../core/events.ts';
import {
  type CachedSchema,
  type GraphQLRequest,
  type Services,
  type SourcesChange,
  UpstreamChange,
  type UpstreamEvent,
} from '../core/services.ts';
import { HttpStatus } from '../core/wire.ts';
import type { Database } from '../db/client.ts';
import { discoveryEndpoints } from '../discovery/endpoints.ts';
import { createLanUpstreamService, type LanUpstreams } from '../discovery/lan-upstreams.ts';
import { createConceptService } from '../gateway/concept-service.ts';
import { createProposalService } from '../gateway/proposal-service.ts';
import { createUnifiedService, UNIFIED_ENDPOINT, type UnifiedGatewayService } from '../gateway/unified-service.ts';
import { UNIFIED_UPSTREAM_ID, withUnifiedUpstream } from '../gateway/unified-upstream.ts';
import { createWiringService } from '../gateway/wiring-service.ts';
import { graphqlLogger } from '../graphql/logger.ts';
import { useOperationLimits } from '../graphql/operation-limits.ts';
import { buildSchema, type Context } from '../graphql/schema.ts';
import { createMcpHandler, MCP_ENDPOINT } from '../mcp/endpoint.ts';
import { createModuleService } from '../modules/module-service.ts';
import { createPageService } from '../pages/page-service.ts';
import { createUpstreamService, isSubscriptionRequest } from '../upstreams/upstream-service.ts';
import { healthHandler } from './health.ts';
import { createStreamProxy, type StreamProxy, wantsStream } from './stream-proxy.ts';

const GRAPHQL_ENDPOINT = '/graphql';
/** Every path but the server's own, so the web app's routes load index.html. */
const WEB_ROUTES = /^(?!\/(graphql|healthz|mcp|unified\/graphql)$)(?!\/proxy\/|\/modules\/[^/]+\/[^/]+\.js$).*/;
/** Where `npm run build` puts the web app. */
export const WEB_DIST = fileURLToPath(new URL('../../dist', import.meta.url));
/** Compiled module code never changes under one URL, since the version is in it. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * What the app is built from. Services left out are built over `db`; the unified gateway always is. A given
 * `upstreams` is the stored upstreams only: the app adds the built-in `unified` one to what it hands out.
 */
export interface AppDeps extends Partial<Omit<Services, 'unified' | 'lanUpstreams'>> {
  db: Database;
  /** LAN discovery. Default: watching only when `LAN_DISCOVER` is on, and only once boot calls `start`. */
  lanUpstreams?: LanUpstreams;
  /** The key MCP clients send. Empty shuts /mcp. */
  mcpKey: string;
  /** Runs a trivial query, rejecting when the database doesn't answer. */
  checkDatabase: () => Promise<unknown>;
  /** How upstream requests leave. Tests pass the fixture's fetch. */
  fetch?: typeof fetch;
  /** The built web app's directory. Left out in tests. */
  dist?: string;
  /** Stream limits to replace, over the environment's. Tests shorten the idle timeout. */
  subscriptions?: Partial<SubscriptionSettings>;
}

/** What createApp builds. */
export interface BuiltApp {
  /** The Express app, not listening. */
  app: Express;
  services: Services;
  /** Not composing until `start`; boot starts it after listen and disposes it on shutdown. */
  unified: UnifiedGatewayService;
  /** The proxy's subscription streams; shutdown closes them at the drain deadline. */
  streams: StreamProxy;
  /** LAN discovery; boot starts it after listen and stops it on shutdown. */
  lanUpstreams: LanUpstreams;
}

/**
 * Reads a proxied request's body.
 *
 * @param body - What express.json parsed.
 * @returns The GraphQL request, or null when it has no `query` string.
 */
function graphqlRequestOf(body: unknown): GraphQLRequest | null {
  const isObject = typeof body === 'object' && body !== null;
  if (isObject === false || 'query' in body === false || typeof body.query !== 'string') {
    return null;
  }
  const variables = 'variables' in body && typeof body.variables === 'object' ? body.variables : null;
  const operationName = 'operationName' in body && typeof body.operationName === 'string' ? body.operationName : null;
  return { query: body.query, variables: variables as Record<string, unknown> | null, operationName };
}

/**
 * Builds the Express app: /graphql for the web app, /mcp for agents, /unified/graphql for the unified API, /proxy
 * to the upstreams (subscriptions streamed over SSE), the compiled module code, /healthz, the discovery documents, and
 * the built web app when there is one. It does not listen.
 *
 * @param deps - The database, the MCP key, and any services a test replaces.
 * @returns The app, the services it was built with, and the unified gateway.
 */
export function createApp({ db, mcpKey, checkDatabase, dist, subscriptions, ...deps }: AppDeps): BuiltApp {
  const fetchDeps = deps.fetch ? { fetch: deps.fetch } : {};
  // Upstream changes are followed in subscription order: concepts follow renames and wiring moves overrides first,
  // then the gateway recomposes.
  const upstreamEvents = createEventFeed<UpstreamEvent>('[upstreams]');
  const changes = createEventFeed<SourcesChange>('[gateway]');
  const servedSchemas = createEventFeed<CachedSchema>('[gateway]');
  // The gateway composes from the stored upstreams; everything else sees them with the built-in `unified` one.
  const stored = deps.upstreams ?? createUpstreamService({ db, events: upstreamEvents, ...fetchDeps });
  const concepts = deps.concepts ?? createConceptService({ db, upstreams: stored, changes, upstreamEvents });
  const wiring = deps.wiring ?? createWiringService({ db, concepts, upstreams: stored, changes, upstreamEvents });
  const unified = createUnifiedService({
    upstreams: stored,
    concepts,
    wiring,
    changes,
    upstreamEvents,
    servedSchemas,
    ...fetchDeps,
  });
  const upstreams = withUnifiedUpstream(stored, unified);
  const modules = deps.modules ?? createModuleService({ db, upstreams });
  // Found APIs become stored upstreams, so it works on those, never on the built-in one.
  const lanUpstreams = deps.lanUpstreams ?? createLanUpstreamService({ upstreams: stored, isWanted: lanDiscover });
  // A schema that changed under its modules re-checks them, so a page shows a module that broke as failing. So does a
  // rename, since `gql.from('<name>')` names an upstream by its name.
  upstreamEvents.subscribe(async (event) => {
    const isRenamed = event.change === UpstreamChange.Updated && event.name !== event.previousName;
    if (event.change === UpstreamChange.Refreshed || isRenamed) {
      await modules.recheck(event.id);
    }
  });
  servedSchemas.subscribe(async () => {
    await modules.recheck(UNIFIED_UPSTREAM_ID);
  });
  const services: Services = {
    upstreams,
    lanUpstreams,
    modules,
    pages: deps.pages ?? createPageService({ db }),
    catalog: deps.catalog ?? createComponentCatalog(),
    concepts,
    // Drafts come from the stored upstreams only: the built-in one already serves the concepts.
    conceptProposals: deps.conceptProposals ?? createProposalService({ db, upstreams: stored, concepts }),
    wiring,
    unified,
  };

  const streams = createStreamProxy(upstreams, { ...subscriptionSettings(), ...subscriptions });

  const yoga = createYoga<object, Context>({
    schema: buildSchema(),
    graphqlEndpoint: GRAPHQL_ENDPOINT,
    logging: graphqlLogger,
    graphiql: isProduction() === false,
    plugins: [useOperationLimits()],
    context: () => services,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy());
  const json = express.json({ limit: HTTP_DEFAULTS.bodyLimit });

  app.get('/healthz', healthHandler(checkDatabase));
  // Public by design, so ahead of every door that asks for a key: the AI Catalog and the Server Card of /mcp.
  app.use(discoveryMiddleware(() => discoveryEndpoints({ version: version() })));
  app.use(GRAPHQL_ENDPOINT, json);
  app.all(GRAPHQL_ENDPOINT, (req, res) => yoga(req, res));
  // Open like /graphql: both are the operator's, on the network Symphony listens on.
  app.use(UNIFIED_ENDPOINT, json);
  app.all(UNIFIED_ENDPOINT, unified.handler);
  app.all(MCP_ENDPOINT, json, createMcpHandler(services, { key: mcpKey, version: version() }));

  // The browser's door to an upstream. Every document is checked against the cached schema first. A subscription
  // that asks for `text/event-stream` streams; a query or a mutation is answered once, as JSON, whatever it accepts.
  app.post('/proxy/:upstreamId', json, async (req, res) => {
    const request = graphqlRequestOf(req.body);
    if (request === null) {
      res.status(HttpStatus.BadRequest).json({ errors: [{ message: 'Send JSON with a "query" string.' }] });
      return;
    }
    if (isSubscriptionRequest(request) && wantsStream(req)) {
      await streams.handle(req.params.upstreamId, request, res);
      return;
    }
    try {
      res.json(await services.upstreams.execute(req.params.upstreamId, request));
    } catch (error) {
      res.status(HttpStatus.NotFound).json({ errors: [{ message: errorMessage(error) }] });
    }
  });

  app.get('/modules/:moduleId/:file', async (req, res) => {
    const module = await services.modules.find(req.params.moduleId);
    const isCurrent = module !== null && req.params.file === `${module.version}.js` && module.compiled !== null;
    if (isCurrent === false) {
      res.status(HttpStatus.NotFound).type('text/plain').send('No compiled code for that module version.');
      return;
    }
    res
      .set('cache-control', IMMUTABLE_CACHE)
      .type('application/javascript')
      .send(module?.compiled ?? '');
  });

  const hasWebBuild = dist !== undefined && existsSync(dist);
  if (hasWebBuild) {
    app.use(express.static(dist));
    app.get(WEB_ROUTES, (_req, res) => res.sendFile('index.html', { root: dist }));
  }
  return { app, services, unified, streams, lanUpstreams };
}
