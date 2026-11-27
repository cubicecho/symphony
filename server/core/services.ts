// The services the two doors (/graphql for the web app, /mcp for agents) share. Each is built once in
// createApp and handed to both, so an agent and a person read and write the same things.
import type { GraphQLSchema } from 'graphql';
import type { Concept } from '../concepts/concept.ts';
import type { ConceptProblem } from '../concepts/validate.ts';
import type { StoredCompileError, StoredHeader } from '../db/schema.ts';
import type { CompositionIssue } from '../gateway/compose.ts';
import type { Source } from '../gateway/sources.ts';
import type { EffectiveWiring, WiringProblem } from '../gateway/wiring.ts';
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
  /** True for one Symphony provides itself (the unified API), which can't be edited, refreshed or removed. */
  builtIn?: boolean;
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

/** What happened to an upstream. */
export const UpstreamChange = {
  Added: 'added',
  Updated: 'updated',
  Removed: 'removed',
  /** A refresh succeeded; its schema may have changed. */
  Refreshed: 'refreshed',
} as const;
export type UpstreamChange = (typeof UpstreamChange)[keyof typeof UpstreamChange];

/** One change to an upstream, told to whoever follows them once the write is done. */
export interface UpstreamEvent {
  change: UpstreamChange;
  id: string;
  /** Its name now. */
  name: string;
  /** Its name before the change: differs from `name` only when an update renamed it. */
  previousName: string;
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
  /** The ids of the upstreams it reads, in order: the first is the default, which a plain `gql` document goes to. */
  upstreamIds: string[];
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
  /** The upstreams it reads, by id or name, in order: the first is the default. At least one, none twice. */
  upstreams: string[];
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
   * @throws NOT_FOUND for an unknown id or upstream, BAD_USER_INPUT for an empty name, no upstreams, one listed twice,
   * or a source over the limit.
   */
  save(input: SaveModuleInput): Promise<SavedModule>;
  /** @returns False when there was no such module. */
  remove(id: string): Promise<boolean>;
  /**
   * Compiles a source without storing it, against its upstreams' schemas.
   *
   * @param upstreams - By id or name, in order: the first is the default.
   * @param source - The TSX.
   * @throws As `save` does for the upstreams and the source.
   */
  check(upstreams: string[], source: string): Promise<CompileResult>;
  /**
   * Compiles every module that reads an upstream (in any position) again against its upstreams' schemas as they are
   * now, storing the ones whose status or errors changed. Each of those goes up a version, since its compiled code may
   * have changed with it.
   *
   * @param upstream - The upstream's id or name.
   * @returns How many modules changed; 0 for an unknown upstream.
   */
  recheck(upstream: string): Promise<number>;
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

/** A stored concept, checked against its members' schemas as they are now. */
export interface ConceptRecord {
  id: string;
  name: string;
  /** The definition as it was submitted. */
  definition: unknown;
  /** The parsed definition, or null when it no longer parses. */
  concept: Concept | null;
  /** What stops it being served now: empty when it can be. */
  problems: ConceptProblem[];
  createdAt: Date;
  updatedAt: Date;
}

/** The concepts the unified gateway serves, stored as data. */
export interface ConceptService {
  /** Every concept, by name, the broken ones included. */
  list(): Promise<ConceptRecord[]>;
  /**
   * Finds one concept.
   *
   * @param idOrName - Its id or its name.
   * @returns The concept with its current problems, or null.
   */
  find(idOrName: string): Promise<ConceptRecord | null>;
  /**
   * Stores a concept, replacing the one with the same name.
   *
   * @param definition - The concept, as JSON.
   * @returns The stored concept, with no problems.
   * @throws BAD_USER_INPUT with `extensions.problems` (ConceptProblem[]) when it does not parse or does not fit its
   * members' schemas, including members that are no upstream or have no cached schema.
   */
  save(definition: unknown): Promise<ConceptRecord>;
  /** @returns False when there was no such concept. */
  remove(idOrName: string): Promise<boolean>;
}

/** Something the unified gateway is composed from changed: a concept or a wiring override. */
export interface SourcesChange {
  /** For the log, e.g. `concept Team saved`. */
  reason: string;
}

/** The wiring every source is composed with, and what kept some of it from being generated. */
export interface WiringState {
  wiring: EffectiveWiring[];
  problems: WiringProblem[];
}

/** The generated wiring of the servable concepts, with users' overrides applied. */
export interface WiringService {
  /** The effective wiring of every source that has any. */
  effective(): Promise<WiringState>;
  /**
   * One source's effective wiring.
   *
   * @param source - An upstream's name, or the concept subgraph's.
   * @returns Its wiring, or null when nothing generates or overrides it.
   */
  find(source: string): Promise<EffectiveWiring | null>;
  /**
   * Stores a source's override, replacing any earlier one.
   *
   * @param source - An upstream's name, or the concept subgraph's.
   * @param override - The override, as JSON; its `upstream` may be left out.
   * @returns The source's effective wiring.
   * @throws NOT_FOUND for an unknown source, BAD_USER_INPUT for an override of the wrong shape.
   */
  setOverride(source: string, override: unknown): Promise<EffectiveWiring>;
  /** @returns False when the source had no override. */
  clearOverride(source: string): Promise<boolean>;
}

/** Where the unified gateway is. */
export const UnifiedState = {
  /** No composition has finished yet. */
  Starting: 'starting',
  /** A supergraph is being served. A later failure leaves it serving, with `lastError` set. */
  Ready: 'ready',
  /** Nothing is served: every composition so far failed. */
  Failed: 'failed',
} as const;
export type UnifiedState = (typeof UnifiedState)[keyof typeof UnifiedState];

/** Which part of the unified API a problem is about. */
export const UnifiedProblemKind = {
  Concept: 'concept',
  Wiring: 'wiring',
  /** A source was left out, e.g. its header secret is not set. */
  Source: 'source',
} as const;
export type UnifiedProblemKind = (typeof UnifiedProblemKind)[keyof typeof UnifiedProblemKind];

/** Something left out of the served supergraph, or wrong with what is in it. */
export interface UnifiedProblem {
  kind: UnifiedProblemKind;
  /** The upstream (or concept subgraph) it is about, when one. */
  source: string | null;
  concept: string | null;
  /** The member document's operation, for a concept problem placed in one. */
  operation: string | null;
  message: string;
  line: number | null;
  column: number | null;
}

/** The last composition that failed. */
export interface UnifiedError {
  message: string;
  /** The composer's reasons; empty when the failure came before composing. */
  issues: CompositionIssue[];
  at: Date;
}

/** One source of the served supergraph. */
export interface UnifiedSource {
  /** The upstream's name, or the concept subgraph's. */
  name: string;
  kind: Source['kind'];
}

/** What the unified gateway serves, and how its last compositions went. */
export interface UnifiedStatus {
  state: UnifiedState;
  /** When the served supergraph was composed; null before the first success. */
  composedAt: Date | null;
  /** The served supergraph's sources. */
  sources: UnifiedSource[];
  /** As of the last composition attempt. */
  problems: UnifiedProblem[];
  /** Null once a composition succeeds. */
  lastError: UnifiedError | null;
}

/** The unified gateway, as the admin API sees it. */
export interface UnifiedService {
  status(): UnifiedStatus;
}

/** Everything a request can reach. */
export interface Services {
  upstreams: UpstreamService;
  modules: ModuleService;
  pages: PageService;
  catalog: ComponentCatalog;
  concepts: ConceptService;
  wiring: WiringService;
  unified: UnifiedService;
}
