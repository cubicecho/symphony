/** How the HTTP server listens and stops. */
export interface HttpSettings {
  /** Port to listen on. `PORT` overrides it. */
  port: number;
  /** Address to listen on. `HOST` overrides it. The LAN by default, so an agent on another machine can reach /mcp. */
  host: string;
  /** Largest request body, in the form express parses. Module sources arrive in it. */
  bodyLimit: string;
  /** How long in-flight requests get to finish on shutdown, in seconds. */
  drainSeconds: number;
  /** When shutdown gives up and exits, in seconds. Below Docker's 10 s stop grace. */
  shutdownDeadlineSeconds: number;
  /** Express `trust proxy`. `TRUST_PROXY` overrides it. */
  trustProxy: boolean | number | string;
}

export const HTTP_DEFAULTS: Readonly<HttpSettings> = Object.freeze({
  port: 3000,
  host: '0.0.0.0',
  bodyLimit: '1mb',
  drainSeconds: 5,
  shutdownDeadlineSeconds: 8,
  trustProxy: false,
});

/** Bounds on one operation against Symphony's own admin API. */
export interface OperationLimitSettings {
  /** Deepest selection allowed. */
  maxDepth: number;
  /** Most aliases in one document. */
  maxAliases: number;
  /** Highest cost an operation may have. */
  maxCost: number;
  /** Cost of a field with no hint of its own. */
  defaultFieldCost: number;
}

export const OPERATION_LIMIT_DEFAULTS: Readonly<OperationLimitSettings> = Object.freeze({
  maxDepth: 8,
  maxAliases: 15,
  maxCost: 10_000,
  defaultFieldCost: 1,
});

/** Where the server keeps what it writes. */
export interface StoreSettings {
  /** Directory holding the built-in database (`pg/`). `DATA_DIR` overrides it. Relative to the working directory. */
  dataDir: string;
}

export const STORE_DEFAULTS: Readonly<StoreSettings> = Object.freeze({
  dataDir: 'data',
});

/** How the server reaches its database (server/db/). */
export interface DatabaseSettings {
  /** How long boot waits for Postgres before giving up, in milliseconds. `DB_CONNECT_TIMEOUT_MS` overrides it. */
  connectTimeoutMs: number;
  /** The wait before the first retry, in milliseconds. */
  firstRetryDelayMs: number;
  /** The longest wait between two retries, in milliseconds. */
  maxRetryDelayMs: number;
  /** How much the wait grows after each failed attempt. */
  retryBackoffFactor: number;
  /** The folder under DATA_DIR where the built-in database (PGlite) keeps its files. */
  pgliteDirName: string;
}

export const DATABASE_DEFAULTS: Readonly<DatabaseSettings> = Object.freeze({
  connectTimeoutMs: 60_000,
  firstRetryDelayMs: 500,
  maxRetryDelayMs: 5_000,
  retryBackoffFactor: 2,
  pgliteDirName: 'pg',
});

/** How Symphony talks to a wrapped (upstream) GraphQL API. */
export interface UpstreamSettings {
  /** How long an introspection request may take, in milliseconds. */
  introspectionTimeoutMs: number;
  /** How long one proxied query or mutation may take, in milliseconds. */
  proxyTimeoutMs: number;
  /** Largest upstream response read, in bytes. */
  maxResponseBytes: number;
  /** What a `${env:…}` header reference's variable name must start with. */
  secretEnvPrefix: string;
}

export const UPSTREAM_DEFAULTS: Readonly<UpstreamSettings> = Object.freeze({
  introspectionTimeoutMs: 15_000,
  proxyTimeoutMs: 30_000,
  maxResponseBytes: 5_000_000,
  secretEnvPrefix: 'SYMPHONY_',
});

/** Bounds on a submitted module. */
export interface ModuleSettings {
  /** Largest module source, in characters. */
  maxSourceChars: number;
  /** Most `gql` documents one module may hold. */
  maxDocuments: number;
  /** Longest module name, in characters. */
  maxNameChars: number;
  /** Most upstreams one module may read. */
  maxUpstreams: number;
}

export const MODULE_DEFAULTS: Readonly<ModuleSettings> = Object.freeze({
  maxSourceChars: 200_000,
  maxDocuments: 20,
  maxNameChars: 80,
  maxUpstreams: 8,
});

/** How a page lays out its modules. */
export interface LayoutSettings {
  /** How many columns a page's grid has at full width. */
  columns: number;
  /** The widest an item can be set to, in columns. */
  maxColumns: number;
  /** How many columns a new item takes. */
  newItemColumns: number;
}

export const LAYOUT_DEFAULTS: Readonly<LayoutSettings> = Object.freeze({
  columns: 4,
  maxColumns: 8,
  newItemColumns: 2,
});

/** Bounds on the MCP door. */
export interface McpSettings {
  /** Largest text one tool answer may hold, in characters. Longer answers are cut with a note saying how to narrow them. */
  maxAnswerChars: number;
  /** Most matches `search_schema` returns. */
  maxSearchResults: number;
}

export const MCP_DEFAULTS: Readonly<McpSettings> = Object.freeze({
  maxAnswerChars: 60_000,
  maxSearchResults: 40,
});

/** How the unified gateway composes its supergraph and swaps one for the next. */
export interface GatewaySettings {
  /** How long operations in flight at a swap get to finish on the old supergraph, in milliseconds. */
  swapDrainMs: number;
  /** How long a change waits for more before the supergraph is recomposed, so a burst composes once, in milliseconds. */
  recomposeDebounceMs: number;
}

export const GATEWAY_DEFAULTS: Readonly<GatewaySettings> = Object.freeze({
  swapDrainMs: 10_000,
  recomposeDebounceMs: 250,
});

/** How Symphony drafts concepts from the upstreams' cached schemas (concepts/propose.ts). */
export interface ProposalSettings {
  /** Shortest name, in characters, two type names may share once a prefix or suffix is removed, to count as one entity. */
  minSharedNameChars: number;
}

export const PROPOSAL_DEFAULTS: Readonly<ProposalSettings> = Object.freeze({
  minSharedNameChars: 3,
});
