// The tools that check, store and read modules.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { badInput, notFound } from '../core/errors.ts';
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

/** The `upstreams` argument: the module's upstreams in order, the first the default. */
const upstreamsArg = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    "The upstreams the module reads, by name or id, in order. The first is the default, which a plain gql document goes to; a document for another goes in gql.from('<name>')`…`.",
  );

/** The older one-upstream argument, still taken. */
const upstreamArg = z
  .string()
  .min(1)
  .optional()
  .describe('One upstream, by name or id: the same as `upstreams` with one entry. Pass one of the two.');

/**
 * Reads a tool's upstreams from `upstreams` or the older single `upstream`.
 *
 * @param args - The tool's arguments.
 * @param args.upstreams - The list, when given.
 * @param args.upstream - The single upstream, when given.
 * @returns The upstreams, the default first.
 * @throws BAD_USER_INPUT when neither or both are given.
 */
function upstreamsOf(args: { upstreams?: string[] | undefined; upstream?: string | undefined }): string[] {
  if (args.upstreams !== undefined && args.upstream !== undefined) {
    throw badInput('Pass `upstreams` (a list) or `upstream` (one name), not both.');
  }
  const upstreams = args.upstreams ?? (args.upstream === undefined ? [] : [args.upstream]);
  if (upstreams.length === 0) {
    throw badInput(
      'Name the upstreams the module reads in `upstreams`, the default first. `list_upstreams` names them.',
    );
  }
  return upstreams;
}

/**
 * Names a module's upstreams for an answer.
 *
 * @param services - The shared services.
 * @param upstreamIds - The module's upstream ids, in order.
 * @returns Their names (the id for one that is gone), in order.
 */
async function upstreamNames(services: Services, upstreamIds: readonly string[]): Promise<string[]> {
  return Promise.all(upstreamIds.map(async (id) => (await services.upstreams.find(id))?.name ?? id));
}

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
        "Compiles a module against its upstreams' schemas without saving it, and lists the errors as `line:column [STAGE] message`. Each gql document is checked against its own upstream. Use it while iterating; `submit_module` runs the same checks and stores the result.",
      inputSchema: {
        upstreams: upstreamsArg,
        upstream: upstreamArg,
        source: sourceArg,
      },
      annotations: { readOnlyHint: true },
    },
    guard('check_module', async ({ upstreams, upstream, source }) => {
      const result = await services.modules.check(upstreamsOf({ upstreams, upstream }), source);
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
        upstreams: upstreamsArg,
        upstream: upstreamArg,
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
    guard('submit_module', async ({ name, upstreams, upstream, source, description, id }) => {
      const { module, compile } = await services.modules.save({
        name,
        upstreams: upstreamsOf({ upstreams, upstream }),
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
        "Lists the stored modules: id, name, upstreams (in order, the default first), status (`READY` or `FAILED`) and version. `get_module` gives one module's source and errors.",
      annotations: { readOnlyHint: true },
    },
    guard('list_modules', async () => {
      const [modules, upstreams] = await Promise.all([services.modules.list(), services.upstreams.list()]);
      const names = new Map(upstreams.map((upstream) => [upstream.id, upstream.name]));
      const rows = modules.map((module) => ({
        id: module.id,
        name: module.name,
        upstreams: module.upstreamIds.map((upstreamId) => names.get(upstreamId) ?? upstreamId),
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
        'Returns one stored module: its name, upstreams (the default first), status, version, the errors of its last compile, and its full source. Use it to fix or extend a module, then `submit_module` with the same id.',
      inputSchema: { id: z.string().min(1).describe("The module's id, from `list_modules` or `submit_module`.") },
      annotations: { readOnlyHint: true },
    },
    guard('get_module', async ({ id }) => {
      const module = await services.modules.find(id);
      if (module === null) {
        throw notFound(`No module "${id}". \`list_modules\` lists them.`);
      }
      const [defaultName, ...others] = await upstreamNames(services, module.upstreamIds);
      const lines = [
        `Module "${module.name}"`,
        `id: ${module.id}`,
        `upstreams: ${[`${defaultName ?? '(none)'} (default)`, ...others].join(', ')}`,
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
