import type { loadOpenAPISubgraph } from '@omnigraph/openapi';

/** The context Mesh source handlers load a schema with. */
export type LoadContext = Parameters<ReturnType<typeof loadOpenAPISubgraph>>[0];

const ignore = () => undefined;

/** The Mesh logger handed to Mesh loaders and transports. They log every step, so only warnings and errors are kept. */
export const meshLogger: LoadContext['logger'] = {
  log: ignore,
  info: ignore,
  debug: ignore,
  warn: (...args) => console.warn('[gateway]', ...args),
  error: (...args) => console.error('[gateway]', ...args),
  child: () => meshLogger,
};
