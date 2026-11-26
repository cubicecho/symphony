import type { createGatewayRuntime } from '@graphql-hive/gateway-runtime';
import { createDefaultExecutor } from '@graphql-mesh/transport-common';
import httpTransport from '@graphql-mesh/transport-http';
import restTransport from '@graphql-mesh/transport-rest';
import { IN_PROCESS_TRANSPORT, type Source } from './sources.ts';

/** The gateway's `transports` option: a transport per kind a supergraph's `@transport` directive names. */
type Transports = NonNullable<Parameters<typeof createGatewayRuntime>[0]['transports']>;
type TransportsGetter = Extract<Transports, (kind: string) => unknown>;
type Transport = Extract<Awaited<ReturnType<TransportsGetter>>, { getSubgraphExecutor: unknown }>;

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
    rest: restTransport,
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
