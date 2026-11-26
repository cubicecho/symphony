// The tools that say how to write a module: the components it may use, their docs, and the module contract.
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notFound } from '../core/errors.ts';
import type { Services } from '../core/services.ts';
import { didYouMean, jsonResult, textResult } from './answers.ts';
import { guard } from './tool-kit.ts';

/** The module contract, served to agents as written. */
const CONTRACT_FILE = new URL('../../docs/module-contract.md', import.meta.url);

/** The topics get_component_docs takes besides component names. */
const DOC_TOPICS = ['index', 'vocabulary'];

/**
 * Reads the module contract.
 *
 * @returns docs/module-contract.md, read fresh so an edit shows without a restart.
 */
export function readModuleContract(): Promise<string> {
  return readFile(CONTRACT_FILE, 'utf-8');
}

/**
 * Lists every name get_component_docs answers to, for suggestions.
 *
 * @param services - The shared services.
 * @returns Export names, file names and the topics.
 */
async function docNames(services: Services): Promise<string[]> {
  const components = await services.catalog.list();
  return [
    ...DOC_TOPICS,
    ...components.flatMap((component) => [
      ...component.exports,
      component.importPath.slice(component.importPath.lastIndexOf('/') + 1),
    ]),
  ];
}

/**
 * Registers list_components, get_component_docs and get_module_contract.
 *
 * @param server - The MCP server.
 * @param services - The shared services.
 */
export function registerComponentTools(server: McpServer, services: Services): void {
  server.registerTool(
    'list_components',
    {
      title: 'List components',
      description:
        "Lists the cubeui components a module may import: the import path (`@/components/card-layout`), the names it exports, and what it is for. `get_component_docs` gives one component's props and examples.",
      annotations: { readOnlyHint: true },
    },
    guard('list_components', async () =>
      jsonResult(await services.catalog.list(), 'Use `get_component_docs` with `index` for an overview by topic.'),
    ),
  );

  server.registerTool(
    'get_component_docs',
    {
      title: 'Get component docs',
      description:
        'Returns the documentation for one cubeui component: its import line, then the doc sections with its props table and examples. `name` is an export (`CardLayout`), an import path (`@/components/card-layout`) or a registry name (`card-layout`). `index` gives the overview and topic list, `vocabulary` the words every slot prop shares.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(
            'A component (`CardLayout`, `card-layout`), `index`, `vocabulary`, or a topic such as `layout/cards`.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    guard('get_component_docs', async ({ name }) => {
      const docs = await services.catalog.docs(name);
      if (docs === null) {
        const hint = didYouMean(name, await docNames(services));
        throw notFound(`No component or topic "${name}".${hint} \`list_components\` lists them all.`);
      }
      return textResult(docs, 'Ask for one of the exports by name, or a narrower topic.');
    }),
  );

  server.registerTool(
    'get_module_contract',
    {
      title: 'Get the module contract',
      description:
        'Returns the rules a Symphony module must follow: its shape, the imports allowed, how GraphQL documents are written and checked, the `symphony` runtime (`gql`, `useQuery`, `useMutation`), and the workflow. Read it before writing a module.',
      annotations: { readOnlyHint: true },
    },
    guard('get_module_contract', async () => textResult(await readModuleContract(), '')),
  );
}
