/** Symphony's admin API, which the web app uses. Agents use /mcp instead. */
export const TYPE_DEFS = /* GraphQL */ `
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

  "A UI module: one TSX file bound to one upstream."
  type Module {
    id: ID!
    name: String!
    description: String!
    upstream: Upstream!
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
    upstreamId: ID!
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

  type Query {
    upstreams: [Upstream!]!
    upstream(id: ID!): Upstream
    modules: [Module!]!
    module(id: ID!): Module
    "Every page, Home first. Home exists from the first boot."
    pages: [Page!]!
    page(slug: String!): Page
    limits: Limits!
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
  }
`;
