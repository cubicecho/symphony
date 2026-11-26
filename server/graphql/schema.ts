// The admin API's resolvers over the shared services. Agents reach the same services through /mcp.
import type { GraphQLSchema } from 'graphql';
import { createSchema } from 'graphql-yoga';
import { LAYOUT_DEFAULTS, MODULE_DEFAULTS } from '../core/defaults.ts';
import { notFound } from '../core/errors.ts';
import {
  type ModuleRecord,
  ModuleStatus,
  type Page,
  type PageItem,
  type Services,
  type Upstream,
} from '../core/services.ts';
import { TYPE_DEFS } from './type-defs.ts';

/** What every resolver reads. */
export type Context = Services;

/**
 * Where the browser loads a module's compiled code. The version is in the path, so it caches forever.
 *
 * @param module - The module.
 * @returns The path, or null while it does not compile.
 */
export function codeUrlOf(module: ModuleRecord): string | null {
  const isReady = module.status === ModuleStatus.Ready && module.compiled !== null;
  return isReady ? `/modules/${module.id}/${module.version}.js` : null;
}

/**
 * Where the browser sends an upstream's queries.
 *
 * @param upstreamId - The upstream.
 * @returns The proxy path.
 */
export function proxyPathOf(upstreamId: string): string {
  return `/proxy/${upstreamId}`;
}

/**
 * Finds a module a page item or a query names.
 *
 * @param ctx - The services.
 * @param id - The module.
 * @returns The module.
 * @throws NOT_FOUND.
 */
async function requireModule(ctx: Context, id: string): Promise<ModuleRecord> {
  const module = await ctx.modules.find(id);
  if (module === null) {
    throw notFound(`There is no module ${id}.`);
  }
  return module;
}

/**
 * Builds the admin schema.
 *
 * @returns The executable schema; its context is the services.
 */
export function buildSchema(): GraphQLSchema {
  return createSchema<Context>({
    typeDefs: TYPE_DEFS,
    resolvers: {
      Query: {
        upstreams: (_: unknown, _args: unknown, ctx: Context) => ctx.upstreams.list(),
        upstream: (_: unknown, args: { id: string }, ctx: Context) => ctx.upstreams.find(args.id),
        modules: (_: unknown, _args: unknown, ctx: Context) => ctx.modules.list(),
        module: (_: unknown, args: { id: string }, ctx: Context) => ctx.modules.find(args.id),
        pages: (_: unknown, _args: unknown, ctx: Context) => ctx.pages.list(),
        page: (_: unknown, args: { slug: string }, ctx: Context) => ctx.pages.find(args.slug),
        limits: () => ({
          columns: LAYOUT_DEFAULTS.columns,
          maxColumns: LAYOUT_DEFAULTS.maxColumns,
          newItemColumns: LAYOUT_DEFAULTS.newItemColumns,
          maxSourceChars: MODULE_DEFAULTS.maxSourceChars,
        }),
      },
      Mutation: {
        addUpstream: (_: unknown, args: { input: Parameters<Context['upstreams']['add']>[0] }, ctx: Context) =>
          ctx.upstreams.add(args.input),
        updateUpstream: (
          _: unknown,
          args: { input: { id: string } & Parameters<Context['upstreams']['add']>[0] },
          ctx: Context,
        ) => {
          const { id, ...input } = args.input;
          return ctx.upstreams.update(id, input);
        },
        deleteUpstream: (_: unknown, args: { id: string }, ctx: Context) => ctx.upstreams.remove(args.id),
        refreshSchema: (_: unknown, args: { id: string }, ctx: Context) => ctx.upstreams.refresh(args.id),
        saveModule: async (
          _: unknown,
          args: {
            input: {
              id?: string | null;
              name: string;
              description?: string | null;
              upstreamId: string;
              source: string;
            };
          },
          ctx: Context,
        ) => {
          const { id, description, upstreamId, ...rest } = args.input;
          const saved = await ctx.modules.save({
            ...rest,
            upstream: upstreamId,
            ...(id == null ? {} : { id }),
            ...(description == null ? {} : { description }),
          });
          return saved.module;
        },
        deleteModule: (_: unknown, args: { id: string }, ctx: Context) => ctx.modules.remove(args.id),
        addPage: (_: unknown, args: { input: { title: string } }, ctx: Context) => ctx.pages.add(args.input.title),
        deletePage: (_: unknown, args: { slug: string }, ctx: Context) => ctx.pages.remove(args.slug),
        addItem: (
          _: unknown,
          args: {
            input: { pageSlug: string; moduleId: string; columnSpan?: number | null; fullWidth?: boolean | null };
          },
          ctx: Context,
        ) => {
          const { columnSpan, fullWidth, ...rest } = args.input;
          return ctx.pages.addItem({
            ...rest,
            ...(columnSpan == null ? {} : { columnSpan }),
            ...(fullWidth == null ? {} : { fullWidth }),
          });
        },
        updateItem: (
          _: unknown,
          args: { input: { id: string; columnSpan: number; fullWidth: boolean } },
          ctx: Context,
        ) => ctx.pages.updateItem(args.input),
        moveItem: (_: unknown, args: { id: string; offset: number }, ctx: Context) =>
          ctx.pages.moveItem(args.id, args.offset),
        removeItem: (_: unknown, args: { id: string }, ctx: Context) => ctx.pages.removeItem(args.id),
      },
      Upstream: {
        proxyPath: (upstream: Upstream) => proxyPathOf(upstream.id),
      },
      UpstreamSchema: {
        fetchedAt: (schema: { fetchedAt: Date }) => schema.fetchedAt.toISOString(),
      },
      Module: {
        upstream: async (module: ModuleRecord, _args: unknown, ctx: Context) => {
          const upstream = await ctx.upstreams.find(module.upstreamId);
          if (upstream === null) {
            throw notFound(`Module ${module.name}'s upstream is gone.`);
          }
          return upstream;
        },
        codeUrl: codeUrlOf,
        updatedAt: (module: ModuleRecord) => module.updatedAt.toISOString(),
      },
      Page: {
        items: (page: Page) => page.items,
      },
      Item: {
        module: (item: PageItem, _args: unknown, ctx: Context) => requireModule(ctx, item.moduleId),
      },
    },
  });
}
