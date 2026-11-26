// What every tool shares: the upstream lookup, and the wrapper that turns a throw into an error result.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage, notFound } from '../core/errors.ts';
import type { CachedSchema, Services, Upstream } from '../core/services.ts';
import { didYouMean, errorResult } from './answers.ts';

/** The tag on this door's log lines. */
export const LOG_TAG = '[mcp]';

/**
 * Finds an upstream by id or name.
 *
 * @param services - The shared services.
 * @param idOrName - What the agent passed.
 * @returns The upstream.
 * @throws NOT_FOUND, naming close upstream names, when there is none.
 */
export async function requireUpstream(services: Services, idOrName: string): Promise<Upstream> {
  const upstream = await services.upstreams.find(idOrName);
  if (upstream !== null) {
    return upstream;
  }
  const names = (await services.upstreams.list()).map((one) => one.name);
  const hint = names.length === 0 ? ' No upstreams are configured yet: a person adds them in Symphony.' : '';
  throw notFound(`No upstream "${idOrName}".${didYouMean(idOrName, names)}${hint} \`list_upstreams\` names them.`);
}

/**
 * Finds an upstream and its cached schema.
 *
 * @param services - The shared services.
 * @param idOrName - What the agent passed.
 * @returns The upstream and its schema.
 * @throws NOT_FOUND when there is no such upstream, or it has never been introspected.
 */
export async function requireSchema(
  services: Services,
  idOrName: string,
): Promise<{ upstream: Upstream; schema: CachedSchema }> {
  const upstream = await requireUpstream(services, idOrName);
  if (upstream.schema === null) {
    throw notFound(
      `Upstream "${upstream.name}" has no cached schema: its introspection has not succeeded yet. A person can refresh it in Symphony.`,
    );
  }
  return { upstream, schema: upstream.schema };
}

/**
 * Wraps a tool's handler so a throw becomes an error result and a log line.
 *
 * @typeParam A - The handler's parameters.
 * @param name - The tool's name, for the log.
 * @param run - The handler.
 * @returns The guarded handler. Arguments are never logged: a query or a source may carry secrets.
 */
export function guard<A extends unknown[]>(
  name: string,
  run: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args) => {
    try {
      return await run(...args);
    } catch (error) {
      console.warn(LOG_TAG, `${name} failed: ${errorMessage(error)}`);
      return errorResult(error);
    }
  };
}
