// The services the two doors (/graphql for the web app, /mcp for agents) share. Each is built once in
// createApp and handed to both, so an agent and a person read and write the same things.
import type { GraphQLSchema } from 'graphql';
import type { Concept } from '../concepts/concept.ts';
import type { ConceptDraft, NotReadyConcept } from '../concepts/propose.ts';
import type { ConceptProblem } from '../concepts/validate.ts';
import type { StoredCompileError, StoredHeader } from '../db/schema.ts';
import type { CompositionIssue } from '../gateway/compose.ts';
import type { FieldConflict } from '../gateway/field-conflicts.ts';
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
  /** The LAN discovery key it was added from, or null (or absent) for one added by hand. */
  discoveredKey?: string | null;
}

/** What adding or changing an upstream takes. */
export interface UpstreamInput {
  name: string;
  url: string;
  headers: StoredHeader[];
  /** The LAN discovery key it comes from. Left out, an update keeps the stored one, unless it changes the URL. */
  discoveredKey?: string | null;
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
  /**
   * Validates one subscription against the cached schema, then opens it on the upstream over SSE with its headers.
   *
   * @param id - The upstream's id or name.
   * @param request - The subscription.
   * @param options - What ends the stream early, and the largest event read.
   * @returns The open stream, or the refusal when validation refused it or the upstream would not stream. Like
   * `execute`, it does not throw for those.
   * @throws NOT_FOUND when there is no such upstream.
   */
  subscribe(id: string, request: GraphQLRequest, options: SubscribeOptions): Promise<UpstreamStream>;
}

/** What `UpstreamService.subscribe` takes besides the request. */
export interface SubscribeOptions {
  /** Aborting it closes the upstream connection. */
  signal: AbortSignal;
  /** The largest event read; a longer one ends the stream with an error. */
  maxEventBytes: number;
}

/**
 * A subscription the upstream is streaming. `events` yields each execution result and returns when the upstream
 * completes. It throws UPSTREAM_FAILED when the upstream drops the connection without completing, sends an event over
 * the limit, or `signal` aborts.
 */
export interface OpenStream {
  isOpen: true;
  events: AsyncIterable<GraphQLResponseBody>;
}

/** A subscription refused before any stream opened. */
export interface RefusedStream {
  isOpen: false;
  /** The errors, as a GraphQL server answers them. */
  body: GraphQLResponseBody;
}

/** What opening a subscription gives. */
export type UpstreamStream = OpenStream | RefusedStream;

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

/** Where a concept proposal is: waiting for a person, or decided. */
export const ProposalStatus = {
  Pending: 'pending',
  /** Saved as a concept. */
  Accepted: 'accepted',
  Rejected: 'rejected',
} as const;
export type ProposalStatus = (typeof ProposalStatus)[keyof typeof ProposalStatus];

/** Who drafted a concept proposal. */
export const ProposalSource = {
  /** Symphony's proposer, from the upstreams' schemas. */
  Generated: 'generated',
  /** An agent, over MCP. */
  Agent: 'agent',
  /** A person, in the web app. */
  User: 'user',
} as const;
export type ProposalSource = (typeof ProposalSource)[keyof typeof ProposalSource];

/** A concept the proposer drafted, with its reasons and what the concept validator says of it. */
export interface ProposedConcept extends ConceptDraft {
  /** What stops it being saved as it is: empty when it could be. */
  problems: ConceptProblem[];
}

/** What proposing found: drafts, and candidates that are not ready to be concepts. */
export interface ConceptProposalsFound {
  drafts: ProposedConcept[];
  notReady: NotReadyConcept[];
}

/** A stored concept proposal. */
export interface ConceptProposalRecord {
  id: string;
  /** The definition's name, or empty when it has none. */
  name: string;
  /** The definition as it was submitted. */
  definition: unknown;
  status: ProposalStatus;
  source: ProposalSource;
  /** What its last submit found: empty when it can be accepted. */
  problems: ConceptProblem[];
  note: string | null;
  /** Why it was rejected. */
  reason: string | null;
  /** The concept accepting it saved; null until then, or once that concept is removed. */
  conceptId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What submitting a concept proposal takes. */
export interface SubmitProposalInput {
  /** The concept, as JSON. */
  definition: unknown;
  /** A pending proposal's id, to revise it. Left out to make a new one. */
  id?: string;
  source: ProposalSource;
  note?: string;
}

/** Concepts drafted from the upstreams and proposed by agents and people; a person accepts them as concepts. */
export interface ConceptProposalService {
  /**
   * Drafts concepts from the upstreams' cached schemas, without storing anything.
   *
   * @param [upstreams] - Only these upstreams' names; every upstream with a cached schema when left out.
   * @throws NOT_FOUND for a name that is no upstream, BAD_USER_INPUT for one with no cached schema.
   */
  propose(upstreams?: readonly string[]): Promise<ConceptProposalsFound>;
  /** Every proposal, newest first, or only those with one status. */
  list(status?: ProposalStatus): Promise<ConceptProposalRecord[]>;
  find(id: string): Promise<ConceptProposalRecord | null>;
  /**
   * Checks a definition and stores it as a pending proposal, problems and all.
   *
   * @throws NOT_FOUND for an unknown id, CONFLICT when that proposal is no longer pending.
   */
  submit(input: SubmitProposalInput): Promise<ConceptProposalRecord>;
  /**
   * Saves a pending proposal as a concept, which recomposes the unified API, and marks it accepted.
   *
   * @throws NOT_FOUND, CONFLICT when it is not pending, BAD_USER_INPUT with `extensions.problems` when the concept
   * service refuses it.
   */
  accept(id: string): Promise<ConceptProposalRecord>;
  /**
   * Marks a pending proposal rejected.
   *
   * @throws NOT_FOUND, CONFLICT when it is not pending.
   */
  reject(id: string, reason?: string): Promise<ConceptProposalRecord>;
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
  /** Every field of a merged type that more than one source provides, and which source serves it. */
  conflicts: FieldConflict[];
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
  /** Field conflicts the gateway resolves by priority or not at all (isWarned), as of the last attempt. */
  warnings: FieldConflict[];
  /** Null once a composition succeeds. */
  lastError: UnifiedError | null;
}

/** The unified gateway, as the admin API sees it. */
export interface UnifiedService {
  status(): UnifiedStatus;
}

/** Everything a request can reach. */
/** Where a GraphQL API found on the LAN stands, as an upstream. */
export const DiscoveredUpstreamState = {
  /** Not added yet, and nothing has to be supplied first. */
  New: 'NEW',
  /** Not added yet; it needs a header only the operator can give, such as a token. */
  NeedsToken: 'NEEDS_TOKEN',
  /** Added, and still on the network. */
  Linked: 'LINKED',
  /** It said goodbye, or its document stopped listing it. An upstream added from it is kept. */
  Offline: 'OFFLINE',
} as const;
export type DiscoveredUpstreamState = (typeof DiscoveredUpstreamState)[keyof typeof DiscoveredUpstreamState];

/** A GraphQL API found on the LAN, offered as an upstream. */
export interface DiscoveredUpstream {
  /** Unique on the network: `<mDNS instance>/<service name>`. */
  key: string;
  /** The service's reverse-DNS name, e.g. `io.github.cubicecho.ethos.nas/api`. */
  serviceName: string;
  title: string | null;
  description: string | null;
  /** The GraphQL endpoint. */
  url: string;
  /** Headers the API says a client must send, e.g. `Authorization`. */
  requiredHeaders: string[];
  /** The mDNS instance that advertised it, e.g. `Ethos on nas`. */
  host: string;
  state: DiscoveredUpstreamState;
  /** The upstream added from it, or null. */
  upstreamId: string | null;
}

/** What adding a discovered API as an upstream takes; its URL comes from the network. */
export interface AddDiscoveredUpstreamInput {
  key: string;
  name: string;
  headers: StoredHeader[];
}

/** GraphQL APIs found on the LAN over mDNS, and adding them as upstreams. */
export interface LanUpstreamService {
  /** Whether the LAN is being watched (`LAN_DISCOVER`). */
  enabled(): boolean;
  /** Every API found since boot, with where it stands. */
  list(): Promise<DiscoveredUpstream[]>;
  /**
   * Adds a found API as an upstream, recording where it came from.
   *
   * @throws NOT_FOUND for an unknown key, BAD_USER_INPUT when it is offline, already added, or a required header is
   * missing, and whatever `UpstreamService.add` throws.
   */
  add(input: AddDiscoveredUpstreamInput): Promise<Upstream>;
}

export interface Services {
  upstreams: UpstreamService;
  lanUpstreams: LanUpstreamService;
  modules: ModuleService;
  pages: PageService;
  catalog: ComponentCatalog;
  concepts: ConceptService;
  conceptProposals: ConceptProposalService;
  wiring: WiringService;
  unified: UnifiedService;
}
