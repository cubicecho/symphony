// The tools that read an upstream: what there is, its schema, and real data from it.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_DEFAULTS } from '../core/defaults.ts';
import type { Services } from '../core/services.ts';
import { jsonResult, textResult } from './answers.ts';
import { printTypeWithNeighbours, searchSchema } from './schema-text.ts';
import { guard, requireSchema, requireUpstream } from './tool-kit.ts';

/** The `upstream` argument every upstream tool takes. */
const upstreamArg = z.string().min(1).describe("The upstream's name (from `list_upstreams`), or its id.");

/**
 * Registers list_upstreams, get_schema, search_schema and run_query.
 *
 * @param server - The MCP server.
 * @param services - The shared services.
 */
export function registerUpstreamTools(server: McpServer, services: Services): void {
  server.registerTool(
    'list_upstreams',
    {
      title: 'List upstreams',
      description:
        'Lists the GraphQL APIs (upstreams) Symphony wraps: name, url, whether its schema is cached, its type count and when it was fetched. Every module is written against one of them; start here. The built-in `unified` one (builtIn: true) is every upstream and concept composed into one API.',
      annotations: { readOnlyHint: true },
    },
    guard('list_upstreams', async () => {
      const upstreams = await services.upstreams.list();
      const rows = upstreams.map((upstream) => ({
        name: upstream.name,
        id: upstream.id,
        url: upstream.url,
        schemaCached: upstream.schema !== null,
        typeCount: upstream.schema?.typeCount ?? 0,
        fetchedAt: upstream.schema?.fetchedAt.toISOString() ?? null,
        builtIn: upstream.builtIn === true,
      }));
      return jsonResult(rows, 'There are more upstreams than fit; ask for one by name with `get_schema`.');
    }),
  );

  server.registerTool(
    'get_schema',
    {
      title: 'Get an upstream schema',
      description:
        "Returns an upstream's cached GraphQL schema as SDL. Without `type`, the whole schema (large APIs get cut: then ask per type or use `search_schema`). With `type`, that type and the types its fields and arguments reference directly; `Query` and `Mutation` give the entry points.",
      inputSchema: {
        upstream: upstreamArg,
        type: z
          .string()
          .min(1)
          .optional()
          .describe('One type name, such as `Query`, `Mutation` or `Order`. Left out for the whole schema.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard('get_schema', async ({ upstream, type }) => {
      const { schema } = await requireSchema(services, upstream);
      if (type === undefined) {
        return textResult(schema.sdl, 'Pass `type` (start with `Query`) or use `search_schema` to read one part.');
      }
      return textResult(
        printTypeWithNeighbours(schema.schema, type),
        'The type references many others; ask for them one at a time.',
      );
    }),
  );

  server.registerTool(
    'search_schema',
    {
      title: 'Search an upstream schema',
      description: `Finds types, fields, arguments and enum values whose name or description contains a text (any case), one line each, like \`Query.orders(first: Int, status: OrderStatus): [Order!]!  — Newest first.\`. At most ${MCP_DEFAULTS.maxSearchResults} lines; \`get_schema\` with a \`type\` gives the full definition.`,
      inputSchema: {
        upstream: upstreamArg,
        text: z.string().min(1).describe('A word or part of one: `order`, `status`, `createdAt`.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard('search_schema', async ({ upstream, text }) => {
      const { schema } = await requireSchema(services, upstream);
      const { lines, omitted } = searchSchema(schema.schema, text, MCP_DEFAULTS.maxSearchResults);
      if (lines.length === 0) {
        return textResult(
          `Nothing in the schema mentions "${text}". Try a shorter word, or \`get_schema\` with type \`Query\`.`,
          '',
        );
      }
      const more =
        omitted === 0 ? [] : ['', `${omitted} more matches left out: search for a longer, more specific text.`];
      return textResult([...lines, ...more].join('\n'), 'Search for a more specific text.');
    }),
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run a GraphQL operation',
      description:
        "Runs one GraphQL document against an upstream through Symphony (with its stored credentials) and returns the JSON response, `errors` included. Use it to try a query and see real data before writing a module. A mutation changes the upstream's real data: run one only when the person asked for it.",
      inputSchema: {
        upstream: upstreamArg,
        query: z.string().min(1).describe('The GraphQL document.'),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The operation's variables, as a JSON object."),
        operation_name: z.string().optional().describe('Which operation to run, when the document holds several.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard('run_query', async ({ upstream, query, variables, operation_name }) => {
      const { id } = await requireUpstream(services, upstream);
      const body = await services.upstreams.execute(id, {
        query,
        variables: variables ?? null,
        operationName: operation_name ?? null,
      });
      return jsonResult(body, 'Select fewer fields, or pass a smaller page size (`first`, `limit`) in the query.');
    }),
  );
}
