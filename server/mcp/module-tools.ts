// The tools that check, store and read modules.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notFound } from '../core/errors.ts';
import type { Services } from '../core/services.ts';
import type { StoredCompileError } from '../db/schema.ts';
import { jsonResult, textResult } from './answers.ts';
import { guard } from './tool-kit.ts';

/** How to get a smaller module answer. */
const NARROW_MODULE = 'The source is long; the errors above the cut come first, so fix those and check again.';

/** The `source` argument: one whole TSX file. */
const sourceArg = z
  .string()
  .min(1)
  .describe('The whole TSX file, as `get_module_contract` describes it. Always the full file, never a diff.');

/**
 * Writes compile errors one per line, placed in the source when they have a place.
 *
 * @param errors - The errors.
 * @returns `12:5 [GRAPHQL] Cannot query field …` lines, or `(none)`.
 */
function formatErrors(errors: readonly StoredCompileError[]): string {
  if (errors.length === 0) {
    return '(none)';
  }
  return errors
    .map((error) => {
      const place = error.line === null ? '' : `${error.line}:${error.column ?? 1} `;
      return `${place}[${error.stage}] ${error.message}`;
    })
    .join('\n');
}

/**
 * Registers check_module, submit_module, list_modules and get_module.
 *
 * @param server - The MCP server.
 * @param services - The shared services.
 */
export function registerModuleTools(server: McpServer, services: Services): void {
  server.registerTool(
    'check_module',
    {
      title: 'Check a module',
      description:
        "Compiles a module against an upstream's schema without saving it, and lists the errors as `line:column [STAGE] message`. Use it while iterating; `submit_module` runs the same checks and stores the result.",
      inputSchema: {
        upstream: z.string().min(1).describe('The upstream the module queries: its name or id.'),
        source: sourceArg,
      },
      annotations: { readOnlyHint: true },
    },
    guard('check_module', async ({ upstream, source }) => {
      const result = await services.modules.check(upstream, source);
      const verdict = result.ok
        ? `ok: the module compiles, with ${result.documents.length} GraphQL document(s). \`submit_module\` stores it.`
        : 'not ok: fix these and check again.';
      return textResult(`${verdict}\n\nErrors:\n${formatErrors(result.errors)}`, NARROW_MODULE);
    }),
  );

  server.registerTool(
    'submit_module',
    {
      title: 'Submit a module',
      description:
        'Compiles and stores a module. It is stored even when it fails, with its errors, so pass the returned `id` on every resubmit to update the same module instead of making a new one. When `ok` is true a person can place it on a page in Symphony.',
      inputSchema: {
        name: z.string().min(1).describe('A short title people see when placing it, such as "Recent orders".'),
        upstream: z.string().min(1).describe('The upstream the module queries: its name or id.'),
        source: sourceArg,
        description: z.string().optional().describe('One line on what it shows.'),
        id: z
          .string()
          .min(1)
          .optional()
          .describe('The id from an earlier submit, to update that module. Left out to create one.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard('submit_module', async ({ name, upstream, source, description, id }) => {
      const { module, compile } = await services.modules.save({
        name,
        upstream,
        source,
        ...(description === undefined ? {} : { description }),
        ...(id === undefined ? {} : { id }),
      });
      const next = compile.ok
        ? 'Next: a person can now place it on a page in Symphony.'
        : `Next: fix the errors and call \`submit_module\` again with id "${module.id}" and the whole file.`;
      const lines = [
        `Saved module "${module.name}".`,
        `id: ${module.id}`,
        `version: ${module.version}`,
        `status: ${module.status}`,
        `ok: ${compile.ok}`,
        '',
        'Errors:',
        formatErrors(compile.errors),
        '',
        next,
      ];
      return textResult(lines.join('\n'), NARROW_MODULE);
    }),
  );

  server.registerTool(
    'list_modules',
    {
      title: 'List modules',
      description:
        "Lists the stored modules: id, name, upstream, status (`READY` or `FAILED`) and version. `get_module` gives one module's source and errors.",
      annotations: { readOnlyHint: true },
    },
    guard('list_modules', async () => {
      const [modules, upstreams] = await Promise.all([services.modules.list(), services.upstreams.list()]);
      const names = new Map(upstreams.map((upstream) => [upstream.id, upstream.name]));
      const rows = modules.map((module) => ({
        id: module.id,
        name: module.name,
        upstream: names.get(module.upstreamId) ?? module.upstreamId,
        status: module.status,
        version: module.version,
      }));
      return jsonResult(rows, 'There are more modules than fit; ask for one by id with `get_module`.');
    }),
  );

  server.registerTool(
    'get_module',
    {
      title: 'Get a module',
      description:
        'Returns one stored module: its name, upstream, status, version, the errors of its last compile, and its full source. Use it to fix or extend a module, then `submit_module` with the same id.',
      inputSchema: { id: z.string().min(1).describe("The module's id, from `list_modules` or `submit_module`.") },
      annotations: { readOnlyHint: true },
    },
    guard('get_module', async ({ id }) => {
      const module = await services.modules.find(id);
      if (module === null) {
        throw notFound(`No module "${id}". \`list_modules\` lists them.`);
      }
      const upstream = await services.upstreams.find(module.upstreamId);
      const lines = [
        `Module "${module.name}"`,
        `id: ${module.id}`,
        `upstream: ${upstream?.name ?? module.upstreamId}`,
        `status: ${module.status}`,
        `version: ${module.version}`,
        `description: ${module.description}`,
        '',
        'Errors:',
        formatErrors(module.errors),
        '',
        'Source:',
        '```tsx',
        module.source,
        '```',
      ];
      return textResult(lines.join('\n'), NARROW_MODULE);
    }),
  );
}
