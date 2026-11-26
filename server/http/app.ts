import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { createYoga } from 'graphql-yoga';
import { createComponentCatalog } from '../catalog/catalog.ts';
import { isProduction, trustProxy, version } from '../core/config.ts';
import { HTTP_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import type { GraphQLRequest, Services } from '../core/services.ts';
import { HttpStatus } from '../core/wire.ts';
import type { Database } from '../db/client.ts';
import { graphqlLogger } from '../graphql/logger.ts';
import { useOperationLimits } from '../graphql/operation-limits.ts';
import { buildSchema, type Context } from '../graphql/schema.ts';
import { createMcpHandler } from '../mcp/endpoint.ts';
import { createModuleService } from '../modules/module-service.ts';
import { createPageService } from '../pages/page-service.ts';
import { createUpstreamService } from '../upstreams/upstream-service.ts';
import { healthHandler } from './health.ts';

const GRAPHQL_ENDPOINT = '/graphql';
const MCP_ENDPOINT = '/mcp';
/** Every path but the server's own, so the web app's routes load index.html. */
const WEB_ROUTES = /^(?!\/(graphql|healthz|mcp)$)(?!\/proxy\/|\/modules\/[^/]+\/[^/]+\.js$).*/;
/** Where `npm run build` puts the web app. */
export const WEB_DIST = fileURLToPath(new URL('../../dist', import.meta.url));
/** Compiled module code never changes under one URL, since the version is in it. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** What the app is built from. Services left out are built over `db`. */
export interface AppDeps extends Partial<Services> {
  db: Database;
  /** The key MCP clients send. Empty shuts /mcp. */
  mcpKey: string;
  /** Runs a trivial query, rejecting when the database doesn't answer. */
  checkDatabase: () => Promise<unknown>;
  /** How upstream requests leave. Tests pass the fixture's fetch. */
  fetch?: typeof fetch;
  /** The built web app's directory. Left out in tests. */
  dist?: string;
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
 * Builds the Express app: /graphql for the web app, /mcp for agents, /proxy to the upstreams, the compiled
 * module code, /healthz, and the built web app when there is one. It does not listen.
 *
 * @param deps - The database, the MCP key, and any services a test replaces.
 * @returns The app and the services it was built with.
 */
export function createApp({ db, mcpKey, checkDatabase, dist, ...deps }: AppDeps): { app: Express; services: Services } {
  const upstreams = deps.upstreams ?? createUpstreamService({ db, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const services: Services = {
    upstreams,
    modules: deps.modules ?? createModuleService({ db, upstreams }),
    pages: deps.pages ?? createPageService({ db }),
    catalog: deps.catalog ?? createComponentCatalog(),
  };

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
  app.use(GRAPHQL_ENDPOINT, json);
  app.all(GRAPHQL_ENDPOINT, (req, res) => yoga(req, res));
  app.all(MCP_ENDPOINT, json, createMcpHandler(services, { key: mcpKey, version: version() }));

  // The browser's door to an upstream. Every document is checked against the cached schema first.
  app.post('/proxy/:upstreamId', json, async (req, res) => {
    const request = graphqlRequestOf(req.body);
    if (request === null) {
      res.status(HttpStatus.BadRequest).json({ errors: [{ message: 'Send JSON with a "query" string.' }] });
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
  return { app, services };
}
