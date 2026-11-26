// Resources: the module contract, and each upstream's cached SDL.
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../core/services.ts';
import { readModuleContract } from './component-tools.ts';
import { requireSchema } from './tool-kit.ts';

/** The contract's resource URI. */
export const CONTRACT_URI = 'contract://module';

/** The URI scheme of an upstream's schema resource, `schema://<name>`. */
const SCHEMA_SCHEME = 'schema://';

/** The media types the resources are served as. */
const MimeType = {
  Markdown: 'text/markdown',
  Graphql: 'application/graphql',
} as const;

/**
 * Registers `contract://module` and the `schema://{upstream}` template.
 *
 * @param server - The MCP server.
 * @param services - The shared services.
 */
export function registerResources(server: McpServer, services: Services): void {
  server.registerResource(
    'module-contract',
    CONTRACT_URI,
    {
      title: 'Module contract',
      description: 'The rules a Symphony module must follow (the same text as `get_module_contract`).',
      mimeType: MimeType.Markdown,
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MimeType.Markdown, text: await readModuleContract() }] }),
  );

  const template = new ResourceTemplate(`${SCHEMA_SCHEME}{upstream}`, {
    list: async () => {
      const upstreams = await services.upstreams.list();
      return {
        resources: upstreams
          .filter((upstream) => upstream.schema !== null)
          .map((upstream) => ({
            uri: `${SCHEMA_SCHEME}${encodeURIComponent(upstream.name)}`,
            name: `${upstream.name} schema`,
            description: `The cached GraphQL schema of ${upstream.url}, as SDL.`,
            mimeType: MimeType.Graphql,
          })),
      };
    },
  });
  server.registerResource(
    'upstream-schema',
    template,
    {
      title: 'Upstream schema',
      description: "An upstream's cached GraphQL schema as SDL, by upstream name.",
      mimeType: MimeType.Graphql,
    },
    async (uri, variables) => {
      const name = decodeURIComponent([variables.upstream ?? ''].flat()[0] ?? '');
      const { schema } = await requireSchema(services, name);
      return { contents: [{ uri: uri.href, mimeType: MimeType.Graphql, text: schema.sdl }] };
    },
  );
}
