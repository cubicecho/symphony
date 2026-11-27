// The admin API's resolvers over the shared services. Agents reach the same services through /mcp.
import { GraphQLScalarType, type GraphQLSchema, valueFromASTUntyped } from 'graphql';
import { createSchema } from 'graphql-yoga';
import { LAYOUT_DEFAULTS, MODULE_DEFAULTS } from '../core/defaults.ts';
import { notFound } from '../core/errors.ts';
import {
  type ConceptRecord,
  type ModuleRecord,
  ModuleStatus,
  type Page,
  type PageItem,
  type Services,
  UnifiedProblemKind,
  UnifiedState,
  type UnifiedStatus,
  type Upstream,
} from '../core/services.ts';
import { UNIFIED_ENDPOINT } from '../gateway/unified-service.ts';
import type { EffectiveWiring, SourceWiring } from '../gateway/wiring.ts';
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

/** Any JSON value, passed through as it is: concept definitions and wiring overrides. */
const JsonScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Any JSON value.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (node, variables) => valueFromASTUntyped(node, variables),
});

/**
 * Lists a rename map's entries, as the API shows them.
 *
 * @param renames - Source name to unified name.
 * @returns One `{ from, to }` per rename.
 */
function renameList(renames: Readonly<Record<string, string>>): { from: string; to: string }[] {
  return Object.entries(renames).map(([from, to]) => ({ from, to }));
}

/** The resolvers Wiring and SourceWiring share, since an effective wiring is a wiring too. */
const WIRING_FIELDS = {
  source: (wiring: SourceWiring) => wiring.upstream,
  renames: (wiring: SourceWiring) => ({
    types: renameList(wiring.renames.types),
    fields: renameList(wiring.renames.fields),
  }),
};

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
        concepts: (_: unknown, _args: unknown, ctx: Context) => ctx.concepts.list(),
        concept: (_: unknown, args: { idOrName: string }, ctx: Context) => ctx.concepts.find(args.idOrName),
        sourceWiring: async (_: unknown, _args: unknown, ctx: Context) => (await ctx.wiring.effective()).wiring,
        unifiedStatus: (_: unknown, _args: unknown, ctx: Context) => ctx.unified.status(),
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
        saveConcept: (_: unknown, args: { definition: unknown }, ctx: Context) => ctx.concepts.save(args.definition),
        removeConcept: (_: unknown, args: { id: string }, ctx: Context) => ctx.concepts.remove(args.id),
        setWiringOverride: (_: unknown, args: { source: string; override: unknown }, ctx: Context) =>
          ctx.wiring.setOverride(args.source, args.override),
        clearWiringOverride: (_: unknown, args: { source: string }, ctx: Context) =>
          ctx.wiring.clearOverride(args.source),
      },
      JSON: JsonScalar,
      Concept: {
        servable: (concept: ConceptRecord) => concept.problems.length === 0,
        createdAt: (concept: ConceptRecord) => concept.createdAt.toISOString(),
        updatedAt: (concept: ConceptRecord) => concept.updatedAt.toISOString(),
      },
      Wiring: WIRING_FIELDS,
      SourceWiring: {
        ...WIRING_FIELDS,
        origins: (wiring: EffectiveWiring) =>
          Object.entries(wiring.origins).map(([entry, origin]) => ({ entry, origin })),
      },
      WiringOrigin: { GENERATED: 'generated', OVERRIDE: 'override' },
      UnifiedState: { STARTING: UnifiedState.Starting, READY: UnifiedState.Ready, FAILED: UnifiedState.Failed },
      UnifiedProblemKind: {
        CONCEPT: UnifiedProblemKind.Concept,
        WIRING: UnifiedProblemKind.Wiring,
        SOURCE: UnifiedProblemKind.Source,
      },
      UnifiedStatus: {
        endpoint: () => UNIFIED_ENDPOINT,
        composedAt: (status: UnifiedStatus) => status.composedAt?.toISOString() ?? null,
      },
      UnifiedError: {
        at: (error: { at: Date }) => error.at.toISOString(),
      },
      Upstream: {
        proxyPath: (upstream: Upstream) => proxyPathOf(upstream.id),
        builtIn: (upstream: Upstream) => upstream.builtIn === true,
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
