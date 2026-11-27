import type { GraphQLSchema } from 'graphql';

/** Renames applied to one source before composition, so its types and fields line up with the unified names. */
export interface SourceRenames {
  /** Source type name to unified type name, e.g. `{ DirectoryTeam: 'Team' }`. */
  types?: Readonly<Record<string, string>>;
  /** `SourceType.field` (the source's own type name) to the new field name, e.g. `{ 'DirectoryTeam.members': 'directoryMembers' }`. */
  fields?: Readonly<Record<string, string>>;
}

/** How the gateway fetches one entity from a source when another source returned it: by key, through a root field. */
export interface MergeKey {
  /** The unified type name, after renames. */
  type: string;
  /** The field that identifies the entity in every source, e.g. `slug`. */
  keyField: string;
  /** The source's root query field that returns the entity by key, after renames. */
  lookupField: string;
  /** The lookup field's argument that takes the key, when it is not named like `keyField`. */
  keyArg?: string;
}

/** What every source kind has. */
interface SourceBase {
  /** Unique among sources; the subgraph name in the supergraph. */
  name: string;
  renames?: SourceRenames;
  mergeKeys?: readonly MergeKey[];
  /**
   * Fields this source leaves out after renames, by unified type name, because another source serves them
   * (field-conflicts.ts). The source still has them; the gateway just never asks it for them.
   */
  hiddenFields?: Readonly<Record<string, readonly string[]>>;
  /** Added server-side to every request the gateway sends this source, e.g. a resolved secret. */
  headers?: Readonly<Record<string, string>>;
}

/** A GraphQL API, described by the SDL Symphony cached from introspection. */
export interface GraphQLSource extends SourceBase {
  kind: 'graphql';
  /** The API's GraphQL endpoint. */
  endpoint: string;
  sdl: string;
}

/** A REST API, described by an OpenAPI 3 document. */
export interface OpenAPISource extends SourceBase {
  kind: 'openapi';
  /** The base URL requests go to. */
  endpoint: string;
  /** Where the OpenAPI document is fetched from. */
  specUrl: string;
}

/** A schema executed in-process, with no network: generated or hand-written resolvers. */
export interface SchemaSource extends SourceBase {
  kind: 'schema';
  schema: GraphQLSchema;
}

/** One API the unified gateway composes. */
export type Source = GraphQLSource | OpenAPISource | SchemaSource;

/** The transport kind the gateway uses for in-process schema sources. */
export const IN_PROCESS_TRANSPORT = 'in-process';
