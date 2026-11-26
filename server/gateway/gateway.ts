import { createGatewayRuntime, type GatewayPlugin, type GatewayRuntime } from '@graphql-hive/gateway-runtime';
import { GATEWAY_DEFAULTS } from '../core/defaults.ts';
import { type ComposeOptions, composeSupergraph, type Supergraph } from './compose.ts';
import type { Source } from './sources.ts';
import { createTransports } from './transports.ts';

/** How to build the unified gateway. */
export interface UnifiedGatewayOptions {
  /** The supergraph to serve first. */
  supergraph: Supergraph;
  /** Sends every request to a source. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Used by `recompose`; `fetch` defaults to the gateway's. */
  compose?: ComposeOptions;
  /** The path the runtime answers GraphQL on. Defaults to `/graphql`. */
  graphqlEndpoint?: string;
}

/** A gateway serving one supergraph at a time, swappable without a restart. */
export interface UnifiedGateway {
  /** The Hive Gateway runtime: a fetch handler, and Express middleware (`app.use('/unified', gateway.runtime)`). */
  runtime: GatewayRuntime;
  /** The supergraph being served. */
  readonly supergraph: Supergraph;
  /**
   * Serves another supergraph from the next request on; in-flight requests finish on the old one.
   *
   * @param supergraph - The new supergraph.
   */
  swap(supergraph: Supergraph): Promise<void>;
  /**
   * Composes the sources and swaps to the result. On failure the current supergraph keeps serving.
   *
   * @param sources - The new set of sources.
   * @returns The new supergraph.
   * @throws {SupergraphCompositionError} When the sources do not compose.
   */
  recompose(sources: readonly Source[]): Promise<Supergraph>;
  /** Closes the runtime and its transports. */
  dispose(): Promise<void>;
}

/**
 * Builds a gateway over a composed supergraph. Sources of kind `schema` execute in-process; the rest go through
 * `fetch`, with each source's `headers` added server-side.
 *
 * @param options - The first supergraph, fetch and endpoint.
 * @returns The gateway.
 */
export function createUnifiedGateway(options: UnifiedGatewayOptions): UnifiedGateway {
  const fetchFn = options.fetch ?? fetch;
  let current = options.supergraph;

  // Every subgraph fetch (GraphQL and REST alike) carries the subgraph it executes against.
  const sourceHeaders: GatewayPlugin = {
    onFetch: ({ options: init, setOptions, executionRequest }) => {
      const source = current.sources.find((one) => one.name === executionRequest?.subgraphName);
      if (source?.headers) {
        setOptions({ ...init, headers: { ...init.headers, ...source.headers } });
      }
    },
  };

  const runtime = createGatewayRuntime({
    supergraph: () => current.sdl,
    graphqlEndpoint: options.graphqlEndpoint ?? '/graphql',
    logging: false,
    // Without it the old generation is disposed at once, aborting in-flight operations (mutations are not retried).
    gracefulSchemaReload: { drainTimeout: GATEWAY_DEFAULTS.swapDrainMs },
    fetchAPI: { fetch: (url, init) => fetchFn(url, init) },
    plugins: () => [sourceHeaders],
    transports: createTransports(() => current.sources),
  });

  const swap = async (supergraph: Supergraph) => {
    current = supergraph;
    runtime.invalidateUnifiedGraph();
    await runtime.getSchema();
  };

  return {
    runtime,
    get supergraph() {
      return current;
    },
    swap,
    recompose: async (sources) => {
      const supergraph = await composeSupergraph(sources, { fetch: fetchFn, ...options.compose });
      await swap(supergraph);
      return supergraph;
    },
    dispose: async () => {
      await runtime.dispose();
    },
  };
}
