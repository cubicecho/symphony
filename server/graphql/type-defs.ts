/** Symphony's admin API, which the web app uses. Agents use /mcp instead. */
export const TYPE_DEFS = /* GraphQL */ `
  "Any JSON value."
  scalar JSON

  "A header Symphony sends with every request to an upstream. The value may hold \${env:SYMPHONY_…} references."
  type Header {
    name: String!
    "As written: a reference is shown as the reference, never as what it resolves to."
    value: String!
  }

  input HeaderInput {
    name: String!
    value: String!
  }

  "The last introspection of an upstream."
  type UpstreamSchema {
    "The schema printed as SDL."
    sdl: String!
    "sha256 of the SDL."
    hash: String!
    typeCount: Int!
    "ISO 8601."
    fetchedAt: String!
  }

  "A GraphQL API Symphony wraps."
  type Upstream {
    id: ID!
    name: String!
    url: String!
    headers: [Header!]!
    "Null until the first refresh succeeds."
    schema: UpstreamSchema
    "Where the browser sends this upstream's queries."
    proxyPath: String!
    "True for the built-in unified API (named unified): its schema is the composed one, and it can't be edited, refreshed or deleted."
    builtIn: Boolean!
  }

  input AddUpstreamInput {
    name: String!
    url: String!
    headers: [HeaderInput!]!
  }

  input UpdateUpstreamInput {
    id: ID!
    name: String!
    url: String!
    headers: [HeaderInput!]!
  }

  "Which step of a compile found a problem."
  enum CompileStage {
    SOURCE
    IMPORTS
    GRAPHQL
    TRANSFORM
  }

  "One problem in a module's source. Lines and columns count from 1."
  type CompileError {
    stage: CompileStage!
    message: String!
    line: Int
    column: Int
  }

  enum ModuleStatus {
    "The last save compiled: codeUrl serves it."
    READY
    "The last save had errors. Pages keep showing nothing for it until it compiles."
    FAILED
  }

  "A UI module: one TSX file over one or more upstreams."
  type Module {
    id: ID!
    name: String!
    description: String!
    "The upstreams it reads, in order. The first is the default: a plain gql document goes to it, and gql.from('<name>') to another."
    upstreams: [Upstream!]!
    source: String!
    status: ModuleStatus!
    errors: [CompileError!]!
    version: Int!
    "Where the browser loads the compiled code. Null while it does not compile."
    codeUrl: String
    "ISO 8601."
    updatedAt: String!
  }

  input SaveModuleInput {
    "Left out to create a module."
    id: ID
    name: String!
    description: String
    "The upstreams it reads, in order: the first is the default. At least one, none twice."
    upstreamIds: [ID!]!
    source: String!
  }

  "A module placed on a page."
  type Item {
    id: ID!
    module: Module!
    columnSpan: Int!
    fullWidth: Boolean!
  }

  type Page {
    slug: String!
    title: String!
    items: [Item!]!
  }

  input AddPageInput {
    title: String!
  }

  input AddItemInput {
    pageSlug: String!
    moduleId: ID!
    columnSpan: Int
    fullWidth: Boolean
  }

  input UpdateItemInput {
    id: ID!
    columnSpan: Int!
    fullWidth: Boolean!
  }

  "Numbers the web forms check against."
  type Limits {
    columns: Int!
    maxColumns: Int!
    newItemColumns: Int!
    maxSourceChars: Int!
  }

  "One problem with a concept, placed in the member document it is about when it has a place. Lines count from 1."
  type ConceptProblem {
    concept: String!
    "The member's upstream name; null for a problem with the concept as a whole."
    member: String
    "Which member document: fetch, create, update or delete."
    operation: String
    message: String!
    line: Int
    column: Int
  }

  "A field of a merged type that more than one source provides. Warnings never stop anything being served."
  type FieldConflictWarning {
    "The concept whose type it is; null for a type only wiring overrides merge."
    concept: String
    type: String!
    field: String!
    "Every source that provides it: upstream names, or symphony_concepts."
    sources: [String!]!
    "The member the concept's priority picks for this field; null when none is set."
    priority: String
    "The source it is served from; null when the gateway picks one."
    servedBy: String
    message: String!
  }

  "One entity read and written across several upstreams, stored as data and served by the unified API."
  type Concept {
    id: ID!
    name: String!
    "The definition as it was saved."
    definition: JSON!
    "True when it has no problems, so the unified API serves it."
    servable: Boolean!
    "Checked against the members' schemas as they are now: an upstream change can break a saved concept."
    problems: [ConceptProblem!]!
    "Fields of its type that several sources provide and no definition default settles: set priority to pick one."
    warnings: [FieldConflictWarning!]!
    "ISO 8601."
    createdAt: String!
    "ISO 8601."
    updatedAt: String!
  }

  "How the gateway fetches an entity from a source by key, through one of its root fields."
  type MergeKey {
    "The unified type name, after renames."
    type: String!
    keyField: String!
    lookupField: String!
    "The lookup field's argument that takes the key, when it is not named like keyField."
    keyArg: String
  }

  "One rename: a source's type name, or a SourceType.field coordinate, to its unified name."
  type Rename {
    from: String!
    to: String!
  }

  type WiringRenames {
    types: [Rename!]!
    fields: [Rename!]!
  }

  "Renames and merge keys for one source."
  type Wiring {
    source: String!
    renames: WiringRenames!
    mergeKeys: [MergeKey!]!
  }

  enum WiringOrigin {
    GENERATED
    OVERRIDE
  }

  "Where one effective wiring entry came from. Entries are named type:<Source>, field:<Source.field> and key:<Type>."
  type WiringEntryOrigin {
    entry: String!
    origin: WiringOrigin!
  }

  "A source's wiring as the unified API composes it: the generated wiring with the user's override applied."
  type SourceWiring {
    "An upstream's name, or symphony_concepts for the concept subgraph."
    source: String!
    renames: WiringRenames!
    mergeKeys: [MergeKey!]!
    "Null when no concept generates wiring for this source."
    generated: Wiring
    "The stored override as JSON; null when the source has none."
    override: JSON
    origins: [WiringEntryOrigin!]!
  }

  enum UnifiedState {
    "No composition has finished yet."
    STARTING
    "A supergraph is being served. A later failed composition leaves it serving, with lastError set."
    READY
    "Nothing is served: every composition so far failed."
    FAILED
  }

  enum UnifiedProblemKind {
    CONCEPT
    WIRING
    "A source was left out, e.g. a header secret it needs is not set."
    SOURCE
  }

  "Something left out of the unified API, or wrong with what is in it."
  type UnifiedProblem {
    kind: UnifiedProblemKind!
    "The upstream, or symphony_concepts, it is about."
    source: String
    concept: String
    operation: String
    message: String!
    line: Int
    column: Int
  }

  "One reason a composition failed."
  type CompositionIssue {
    message: String!
    "The composer's code, such as FIELD_TYPE_MISMATCH or SOURCE_LOAD_FAILED."
    code: String!
    "The source at fault, when one is."
    source: String
  }

  type UnifiedError {
    message: String!
    issues: [CompositionIssue!]!
    "ISO 8601."
    at: String!
  }

  type UnifiedSource {
    "The upstream's name, or symphony_concepts."
    name: String!
    "graphql for an upstream, schema for the concept subgraph."
    kind: String!
  }

  "The unified API: every upstream and the servable concepts, composed into one GraphQL endpoint."
  type UnifiedStatus {
    state: UnifiedState!
    "Where the unified API is served."
    endpoint: String!
    "ISO 8601; null before the first successful composition."
    composedAt: String
    sources: [UnifiedSource!]!
    "As of the last composition attempt."
    problems: [UnifiedProblem!]!
    "Field conflicts, as of the last composition attempt."
    warnings: [FieldConflictWarning!]!
    "The last failed composition; null once one succeeds."
    lastError: UnifiedError
  }

  type Query {
    upstreams: [Upstream!]!
    upstream(id: ID!): Upstream
    modules: [Module!]!
    module(id: ID!): Module
    "Every page, Home first. Home exists from the first boot."
    pages: [Page!]!
    page(slug: String!): Page
    limits: Limits!
    "Every concept, the ones that can't be served included."
    concepts: [Concept!]!
    concept(idOrName: String!): Concept
    "The effective wiring of every source that has any."
    sourceWiring: [SourceWiring!]!
    unifiedStatus: UnifiedStatus!
  }

  type Mutation {
    "Adds an upstream and introspects it. The upstream is kept even when introspection fails; refreshSchema tries again."
    addUpstream(input: AddUpstreamInput!): Upstream!
    updateUpstream(input: UpdateUpstreamInput!): Upstream!
    "Deletes an upstream with its modules, and their places on pages."
    deleteUpstream(id: ID!): Boolean!
    "Introspects the upstream again and replaces its cached schema."
    refreshSchema(id: ID!): Upstream!
    "Creates or replaces a module and compiles it. A module that fails to compile is still saved, with its errors."
    saveModule(input: SaveModuleInput!): Module!
    deleteModule(id: ID!): Boolean!
    addPage(input: AddPageInput!): Page!
    "Home can't be deleted."
    deletePage(slug: String!): Boolean!
    addItem(input: AddItemInput!): Page!
    updateItem(input: UpdateItemInput!): Page!
    "Moves an item one place earlier (-1) or later (1)."
    moveItem(id: ID!, offset: Int!): Page!
    removeItem(id: ID!): Page!
    "Stores a concept, replacing the one with the same name. Refused with BAD_USER_INPUT and extensions.problems when it does not fit its members' schemas."
    saveConcept(definition: JSON!): Concept!
    removeConcept(id: ID!): Boolean!
    "Stores a source's wiring override, replacing any earlier one. The override's upstream may be left out."
    setWiringOverride(source: String!, override: JSON!): SourceWiring!
    clearWiringOverride(source: String!): Boolean!
  }
`;
