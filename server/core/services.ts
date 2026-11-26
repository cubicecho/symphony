// The services the two doors (/graphql for the web app, /mcp for agents) share. Each is built once in
// createApp and handed to both, so an agent and a person read and write the same things.
import type { GraphQLSchema } from 'graphql';
import type { StoredCompileError, StoredHeader } from '../db/schema.ts';
import type { CompileResult } from '../modules/compile-result.ts';

/** An upstream's cached schema. */
export interface CachedSchema {
  /** Rebuilt from the stored introspection; it has no resolvers. */
  schema: GraphQLSchema;
  sdl: string;
  hash: string;
  typeCount: number;
  fetchedAt: Date;
}

/** A GraphQL API Symphony wraps. */
export interface Upstream {
  id: string;
  name: string;
  url: string;
  /** As stored: `${env:…}` references unresolved. */
  headers: StoredHeader[];
  /** Null until an introspection succeeds. */
  schema: CachedSchema | null;
}

/** What adding or changing an upstream takes. */
export interface UpstreamInput {
  name: string;
  url: string;
  headers: StoredHeader[];
}

/** One GraphQL request, as a client sends it. */
export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

/** A GraphQL response body, as it goes back to the client. */
export interface GraphQLResponseBody {
  data?: unknown;
  errors?: { message: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

/** The upstreams, their cached schemas, and the proxy to them. */
export interface UpstreamService {
  list(): Promise<Upstream[]>;
  /**
   * Finds one upstream.
   *
   * @param idOrName - Its id, or its name (agents use names).
   * @returns The upstream, or null.
   */
  find(idOrName: string): Promise<Upstream | null>;
  /**
   * Adds an upstream, then tries to introspect it.
   *
   * @param input - Name, URL and headers.
   * @returns The upstream, with `schema` null when introspection failed.
   * @throws BAD_USER_INPUT for a bad name or URL, or a name in use.
   */
  add(input: UpstreamInput): Promise<Upstream>;
  /**
   * Replaces an upstream's name, URL and headers. The cached schema stays until the next refresh.
   *
   * @throws NOT_FOUND, BAD_USER_INPUT.
   */
  update(id: string, input: UpstreamInput): Promise<Upstream>;
  /** Deletes an upstream with its schema and modules. @returns False when there was no such upstream. */
  remove(id: string): Promise<boolean>;
  /**
   * Introspects an upstream and replaces its cached schema.
   *
   * @throws NOT_FOUND, or UPSTREAM_FAILED with the reason the introspection failed (secrets redacted).
   */
  refresh(id: string): Promise<Upstream>;
  /**
   * Validates one request against the cached schema, then sends it to the upstream with its headers.
   *
   * @param id - The upstream's id or name.
   * @param request - The request.
   * @returns The upstream's response body, or a body with `errors` when validation refused it or the upstream
   * could not be reached. It never throws for those, so the proxy can answer as a GraphQL server would.
   * @throws NOT_FOUND when there is no such upstream.
   */
  execute(id: string, request: GraphQLRequest): Promise<GraphQLResponseBody>;
}

/** A module's status. */
export const ModuleStatus = {
  Ready: 'READY',
  Failed: 'FAILED',
} as const;
export type ModuleStatus = (typeof ModuleStatus)[keyof typeof ModuleStatus];

/** A stored module. */
export interface ModuleRecord {
  id: string;
  name: string;
  description: string;
  upstreamId: string;
  source: string;
  compiled: string | null;
  status: ModuleStatus;
  errors: StoredCompileError[];
  version: number;
  updatedAt: Date;
}

/** What saving a module takes. */
export interface SaveModuleInput {
  /** Left out to create one. */
  id?: string;
  name: string;
  description?: string;
  /** The upstream's id or name. */
  upstream: string;
  source: string;
}

/** What a save hands back: the stored module and the compile that ran on it. */
export interface SavedModule {
  module: ModuleRecord;
  compile: CompileResult;
}

/** The modules, compiled on every save. */
export interface ModuleService {
  list(): Promise<ModuleRecord[]>;
  find(id: string): Promise<ModuleRecord | null>;
  /**
   * Compiles and stores a module. A source that fails to compile is stored too, with its errors and no code.
   *
   * @throws NOT_FOUND for an unknown id or upstream, BAD_USER_INPUT for an empty name or a source over the limit.
   */
  save(input: SaveModuleInput): Promise<SavedModule>;
  /** @returns False when there was no such module. */
  remove(id: string): Promise<boolean>;
  /** Compiles a source without storing it, against an upstream's schema. */
  check(upstream: string, source: string): Promise<CompileResult>;
}

/** A module placed on a page. */
export interface PageItem {
  id: string;
  moduleId: string;
  columnSpan: number;
  fullWidth: boolean;
}

/** A page of modules. */
export interface Page {
  slug: string;
  title: string;
  items: PageItem[];
}

/** The slug of the page every instance has. */
export const HOME_SLUG = 'home';

/** The pages and what is placed on them. */
export interface PageService {
  /** Every page, Home first. */
  list(): Promise<Page[]>;
  find(slug: string): Promise<Page | null>;
  add(title: string): Promise<Page>;
  /** @throws BAD_USER_INPUT for Home. @returns False when there was no such page. */
  remove(slug: string): Promise<boolean>;
  addItem(input: { pageSlug: string; moduleId: string; columnSpan?: number; fullWidth?: boolean }): Promise<Page>;
  updateItem(input: { id: string; columnSpan: number; fullWidth: boolean }): Promise<Page>;
  moveItem(id: string, offset: number): Promise<Page>;
  removeItem(id: string): Promise<Page>;
}

/** One cubeui component an agent may import. */
export interface CatalogComponent {
  /** The import specifier, `@/components/card-layout`. */
  importPath: string;
  /** The names the file exports. */
  exports: string[];
  /** One line on what it is for, from the registry. Empty when the registry has none. */
  description: string;
}

/** The components modules may use, and their documentation. */
export interface ComponentCatalog {
  list(): Promise<CatalogComponent[]>;
  /**
   * The documentation for one component or topic.
   *
   * @param name - A component name (`CardLayout`), an import path or a registry name (`card-layout`).
   * @returns Markdown, or null when nothing matches.
   */
  docs(name: string): Promise<string | null>;
}

/** Everything a request can reach. */
export interface Services {
  upstreams: UpstreamService;
  modules: ModuleService;
  pages: PageService;
  catalog: ComponentCatalog;
}
