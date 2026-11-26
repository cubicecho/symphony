import type { createGatewayRuntime } from '@graphql-hive/gateway-runtime';
import { createDefaultExecutor } from '@graphql-mesh/transport-common';
import httpTransport from '@graphql-mesh/transport-http';
import restTransport from '@graphql-mesh/transport-rest';
import { meshLogger } from './logger.ts';
import { IN_PROCESS_TRANSPORT, type Source } from './sources.ts';

/** The gateway's `transports` option: a transport per kind a supergraph's `@transport` directive names. */
type Transports = NonNullable<Parameters<typeof createGatewayRuntime>[0]['transports']>;
type TransportsGetter = Extract<Transports, (kind: string) => unknown>;
type Transport = Extract<Awaited<ReturnType<TransportsGetter>>, { getSubgraphExecutor: unknown }>;

/** What transport-rest's executor factory takes: transport-common 1's options, where Gateway 3 passes 2's. */
type RestTransportOptions = Parameters<typeof restTransport.getSubgraphExecutor>[0];

/**
 * The REST transport, adapted to Gateway 3. transport-rest 0.12 is still built on transport-common 1: it reads the
 * Mesh `logger` the gateway stopped passing (it passes `log`), and its option types name another copy of the Hive
 * logger. The adapter hands it a logger, and the cast bridges the two copies' types, which match at runtime.
 */
const restForGateway: Transport = {
  getSubgraphExecutor: (options) =>
    restTransport.getSubgraphExecutor({ ...options, logger: meshLogger } as unknown as RestTransportOptions),
};

/**
 * Executes an in-process source's schema directly, with no network.
 *
 * @param getSources - Reads the sources being served, so a swap reaches executors built later.
 * @returns The transport.
 */
function inProcessTransport(getSources: () => readonly Source[]): Transport {
  return {
    getSubgraphExecutor: ({ subgraphName }) => {
      const source = getSources().find((one) => one.name === subgraphName);
      if (source?.kind !== 'schema') {
        throw new Error(`No in-process schema for source ${subgraphName}.`);
      }
      return createDefaultExecutor(source.schema);
    },
  };
}

/**
 * Builds the gateway's transports: HTTP for GraphQL sources, REST for OpenAPI sources, in-process for schema sources.
 *
 * @param getSources - Reads the sources being served.
 * @returns The `transports` option.
 * @throws {Error} From the getter, for a kind no source produces.
 */
export function createTransports(getSources: () => readonly Source[]): TransportsGetter {
  const byKind: Readonly<Record<string, Transport>> = {
    http: httpTransport,
    rest: restForGateway,
    [IN_PROCESS_TRANSPORT]: inProcessTransport(getSources),
  };
  return (kind) => {
    const transport = byKind[kind];
    if (transport === undefined) {
      throw new Error(`The gateway has no transport for kind "${kind}".`);
    }
    return transport;
  };
}
