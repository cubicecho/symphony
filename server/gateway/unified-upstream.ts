// The unified API as an upstream modules can be written against. It is built in: it has no row, so it is added by
// decorating the upstream service the admin API, /mcp, /proxy and the modules see. The unified gateway itself
// composes from the undecorated service, so it never composes from its own output.
import { badInput, ErrorCode } from '../core/errors.ts';
import type { Upstream, UpstreamInput, UpstreamService } from '../core/services.ts';
import { errorBody, refusalOf } from '../upstreams/upstream-service.ts';
import { UNIFIED_ENDPOINT, type UnifiedGatewayService } from './unified-service.ts';

/**
 * The built-in upstream's name. It matches the endpoint it serves (/unified/graphql), is a plain word agents can
 * type, and is refused as the name of any other upstream.
 */
export const UNIFIED_UPSTREAM_NAME = 'unified';

/** The built-in upstream's fixed id, so modules written against it keep pointing at it across restarts. */
export const UNIFIED_UPSTREAM_ID = '00000000-0000-4000-8000-000000000001';

/** What the decorator reads from the unified gateway. */
type ServedGraph = Pick<UnifiedGatewayService, 'servedSchema' | 'execute'>;

/**
 * Whether an id or name means the built-in upstream.
 *
 * @param idOrName - What the caller passed.
 * @returns True for its id or its name.
 */
export function isUnifiedUpstream(idOrName: string): boolean {
  return idOrName === UNIFIED_UPSTREAM_ID || idOrName === UNIFIED_UPSTREAM_NAME;
}

/**
 * Refuses a write to the built-in upstream.
 *
 * @param idOrName - What the caller passed.
 * @param what - The refused action, as in `edited`.
 * @throws BAD_USER_INPUT when it is the built-in upstream.
 */
function refuseBuiltIn(idOrName: string, what: string): void {
  if (isUnifiedUpstream(idOrName)) {
    throw badInput(
      `"${UNIFIED_UPSTREAM_NAME}" is the built-in unified API and can't be ${what}: it follows the concepts, the wiring and the other upstreams.`,
    );
  }
}

/**
 * Refuses the reserved name for any other upstream.
 *
 * @param input - What adding or updating an upstream takes.
 * @throws BAD_USER_INPUT for the built-in upstream's name.
 */
function refuseReservedName(input: UpstreamInput): void {
  if (input.name.trim() === UNIFIED_UPSTREAM_NAME) {
    throw badInput(`"${UNIFIED_UPSTREAM_NAME}" is the name of the built-in unified API; pick another name.`);
  }
}

/**
 * Adds the built-in `unified` upstream to an upstream service. Its schema is the served supergraph's, and its
 * requests are validated against it, then run in-process on the gateway runtime. It can't be added, updated,
 * refreshed or removed.
 *
 * @param upstreams - The upstreams as stored, which the unified gateway composes from.
 * @param unified - The gateway serving the composed supergraph.
 * @returns The same service with the built-in upstream first in every list.
 */
export function withUnifiedUpstream(upstreams: UpstreamService, unified: ServedGraph): UpstreamService {
  const builtIn = (): Upstream => ({
    id: UNIFIED_UPSTREAM_ID,
    name: UNIFIED_UPSTREAM_NAME,
    url: UNIFIED_ENDPOINT,
    headers: [],
    schema: unified.servedSchema(),
    builtIn: true,
  });

  return {
    list: async () => [builtIn(), ...(await upstreams.list())],

    find: async (idOrName) => (isUnifiedUpstream(idOrName) ? builtIn() : upstreams.find(idOrName)),

    add: async (input) => {
      refuseReservedName(input);
      return upstreams.add(input);
    },

    update: async (id, input) => {
      refuseBuiltIn(id, 'edited');
      refuseReservedName(input);
      return upstreams.update(id, input);
    },

    remove: async (id) => {
      refuseBuiltIn(id, 'removed');
      return upstreams.remove(id);
    },

    refresh: async (id) => {
      refuseBuiltIn(id, 'refreshed');
      return upstreams.refresh(id);
    },

    execute: async (id, request) => {
      if (isUnifiedUpstream(id) === false) {
        return upstreams.execute(id, request);
      }
      const schema = unified.servedSchema();
      if (schema === null) {
        return errorBody(
          "The unified API has no schema yet: no composition has succeeded. The admin API's unifiedStatus says why.",
          ErrorCode.UpstreamFailed,
        );
      }
      return refusalOf(UNIFIED_UPSTREAM_NAME, schema, request) ?? unified.execute(request);
    },
  };
}
