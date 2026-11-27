import {
  composeSubgraphs,
  createFederationTransform,
  createRenameTransform,
  type SubgraphConfig,
  type SubgraphTransform,
} from '@graphql-mesh/fusion-composition';
import { MapperKind, mapSchema } from '@graphql-tools/utils';
import { loadOpenAPISubgraph } from '@omnigraph/openapi';
import {
  buildSchema,
  type DefinitionNode,
  type DocumentNode,
  type FieldDefinitionNode,
  GraphQLSchema,
  Kind,
  type ObjectTypeExtensionNode,
  parse,
  print,
} from 'graphql';
import { errorMessage } from '../core/errors.ts';
import { type LoadContext, meshLogger } from './logger.ts';
import { IN_PROCESS_TRANSPORT, type MergeKey, type Source, type SourceRenames } from './sources.ts';

/** The codes a composition issue carries besides the federation composer's own (`INVALID_FIELD_SHARING`, ...). */
export const CompositionIssueCode = {
  /** A source's schema could not be loaded: its OpenAPI document did not fetch or parse. */
  SourceLoadFailed: 'SOURCE_LOAD_FAILED',
  /** A transform refused the source, e.g. a merge key names a type or field it does not have. */
  TransformFailed: 'TRANSFORM_FAILED',
  /** An `additionalTypeDefs` field extends a type the supergraph does not have. */
  UnknownExtendedType: 'UNKNOWN_EXTENDED_TYPE',
  /** The federation composer refused the sources without saying why in a code. */
  CompositionFailed: 'COMPOSITION_FAILED',
} as const;

/** One reason composition failed. */
export interface CompositionIssue {
  message: string;
  /** The federation composer's code (`FIELD_TYPE_MISMATCH`, ...) or a CompositionIssueCode. */
  code: string;
  /** The source at fault, when one is. */
  source?: string;
}

/** Composition failed; `issues` holds every reason, each with a code a UI can show next to the source. */
export class SupergraphCompositionError extends Error {
  readonly issues: readonly CompositionIssue[];

  /**
   * @param issues - Every reason composition failed.
   */
  constructor(issues: readonly CompositionIssue[]) {
    super(`Could not compose the supergraph:\n${issues.map((issue) => `- ${issue.message}`).join('\n')}`);
    this.name = 'SupergraphCompositionError';
    this.issues = issues;
  }
}

/** A composed supergraph, and the sources it was composed from (the gateway reads headers and in-process schemas from them). */
export interface Supergraph {
  sdl: string;
  sources: readonly Source[];
}

/** What composition needs besides the sources. */
export interface ComposeOptions {
  /** Fetches OpenAPI documents. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * SDL extending the composed types with cross-source fields, each annotated with `@resolveTo`, e.g.
   * `extend type Team { invoices: [Invoice] @resolveTo(sourceName: "billing", ...) }`.
   */
  additionalTypeDefs?: string;
}

/**
 * Builds the rename transform for one source.
 *
 * @param renames - The source's type and field renames, by its own names.
 * @returns The transform.
 */
function renameTransform(renames: SourceRenames): SubgraphTransform {
  const typeRenames = Object.entries(renames.types ?? {}).map(([from, to]) => ({
    from: { type: from },
    to: { type: to },
  }));
  // Mesh matches a field rename against the type's name before the type rename, so both ends name the source type.
  const fieldRenames = Object.entries(renames.fields ?? {}).map(([coordinate, to]) => {
    const [type, field] = coordinate.split('.');
    return { from: { type, field }, to: { type, field: to } };
  });
  return createRenameTransform({ renames: [...typeRenames, ...fieldRenames] });
}

/**
 * Builds the transform that removes the fields another source serves, so the gateway reads each from one source.
 * Mesh's filter transform is not used: it marks fields `@inaccessible`, which Federation applies to the field in the
 * whole supergraph, not just in this source.
 *
 * @param hidden - Field names after renames, by type name after renames.
 * @returns The transform.
 */
function hideFieldsTransform(hidden: Readonly<Record<string, readonly string[]>>): SubgraphTransform {
  return (schema) =>
    mapSchema(schema, {
      [MapperKind.OBJECT_FIELD]: (field, fieldName, typeName) =>
        hidden[typeName]?.includes(fieldName) === true ? null : field,
    });
}

/**
 * Builds the transform that tells the gateway how to merge a source's entities with other sources'.
 * Each merged type is marked shareable, because merged sources resolve the same fields (`slug`, `name`).
 *
 * @param mergeKeys - The source's entity keys and lookups.
 * @returns The transform.
 */
function mergeTransform(mergeKeys: readonly MergeKey[]): SubgraphTransform {
  const config = Object.fromEntries(
    mergeKeys.map((mergeKey) => [
      mergeKey.type,
      {
        shareable: true,
        key: {
          fields: mergeKey.keyField,
          resolveReference: { fieldName: mergeKey.lookupField, keyField: mergeKey.keyField, keyArg: mergeKey.keyArg },
        },
      },
    ]),
  );
  return createFederationTransform(config);
}

/**
 * Marks an in-process schema with the transport the gateway executes it through.
 *
 * @param name - The source name.
 * @param schema - The schema.
 * @returns A copy carrying a `@transport(kind: "in-process")` schema directive.
 */
function withInProcessTransport(name: string, schema: GraphQLSchema): GraphQLSchema {
  const transport = { kind: IN_PROCESS_TRANSPORT, subgraph: name, location: name };
  const config = schema.toConfig();
  return new GraphQLSchema({ ...config, extensions: { ...config.extensions, directives: { transport: [transport] } } });
}

/**
 * Loads one source's schema.
 *
 * @param source - The source.
 * @param context - What Mesh loaders need.
 * @returns The schema, before transforms.
 */
async function loadSchema(source: Source, context: LoadContext): Promise<GraphQLSchema> {
  switch (source.kind) {
    case 'graphql':
      return buildSchema(source.sdl);
    case 'openapi':
      return loadOpenAPISubgraph(source.name, { source: source.specUrl, endpoint: source.endpoint })(context).schema$;
    case 'schema':
      return withInProcessTransport(source.name, source.schema);
  }
}

/**
 * Loads a source and attaches its transforms.
 *
 * @param source - The source.
 * @param context - What Mesh loaders need.
 * @returns The subgraph config, or the issue that stopped it.
 */
async function toSubgraph(source: Source, context: LoadContext): Promise<SubgraphConfig | CompositionIssue> {
  let schema: GraphQLSchema;
  try {
    schema = await loadSchema(source, context);
  } catch (error) {
    return {
      message: `${source.name}: ${errorMessage(error)}`,
      code: CompositionIssueCode.SourceLoadFailed,
      source: source.name,
    };
  }
  const transforms = [
    ...(source.renames ? [renameTransform(source.renames)] : []),
    ...(source.hiddenFields ? [hideFieldsTransform(source.hiddenFields)] : []),
    ...(source.mergeKeys?.length ? [mergeTransform(source.mergeKeys)] : []),
  ];
  const url = source.kind === 'graphql' ? source.endpoint : undefined;
  const subgraph: SubgraphConfig = { name: source.name, schema, url, transforms };
  try {
    // A dry run, so a transform's refusal names its source; Mesh's composer applies them again for real.
    transforms.reduce((transformed, transform) => transform(transformed, subgraph), schema);
  } catch (error) {
    return {
      message: `${source.name}: ${errorMessage(error)}`,
      code: CompositionIssueCode.TransformFailed,
      source: source.name,
    };
  }
  return subgraph;
}

/**
 * Adds the `additionalTypeDefs` fields to their types in the supergraph, marked `@additionalField` as Mesh's compose
 * CLI does, so the gateway resolves them through their `@resolveTo` directive instead of a subgraph.
 *
 * @param supergraphSdl - The composed supergraph.
 * @param additionalTypeDefs - `extend type` blocks, and any new types they need.
 * @returns The supergraph with the fields added.
 */
function addAdditionalFields(supergraphSdl: string, additionalTypeDefs: string): string {
  const supergraph = parse(supergraphSdl);
  const extra = parse(additionalTypeDefs);
  const extensions = extra.definitions.filter(
    (definition): definition is ObjectTypeExtensionNode => definition.kind === Kind.OBJECT_TYPE_EXTENSION,
  );
  const newDefinitions = extra.definitions.filter((definition) => definition.kind !== Kind.OBJECT_TYPE_EXTENSION);
  const markField = (field: FieldDefinitionNode): FieldDefinitionNode => ({
    ...field,
    directives: [
      ...(field.directives ?? []),
      { kind: Kind.DIRECTIVE, name: { kind: Kind.NAME, value: 'additionalField' } },
    ],
  });
  const unknownTypes = extensions
    .map((extension) => extension.name.value)
    .filter((typeName) =>
      supergraph.definitions.every(
        (definition) => definition.kind !== Kind.OBJECT_TYPE_DEFINITION || definition.name.value !== typeName,
      ),
    );
  if (unknownTypes.length > 0) {
    throw new SupergraphCompositionError(
      unknownTypes.map((typeName) => ({
        message: `additionalTypeDefs extends ${typeName}, which no source has.`,
        code: CompositionIssueCode.UnknownExtendedType,
      })),
    );
  }
  const definitions: DefinitionNode[] = supergraph.definitions.map((definition) => {
    if (definition.kind !== Kind.OBJECT_TYPE_DEFINITION) {
      return definition;
    }
    const addedFields = extensions
      .filter((extension) => extension.name.value === definition.name.value)
      .flatMap((extension) => (extension.fields ?? []).map(markField));
    return { ...definition, fields: [...(definition.fields ?? []), ...addedFields] };
  });
  const additionalFieldDirective = parse('directive @additionalField on FIELD_DEFINITION').definitions;
  const document: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [...additionalFieldDirective, ...definitions, ...newDefinitions],
  };
  return print(document);
}

/**
 * Composes sources into one supergraph at runtime: loads each source's schema, renames its types and fields, declares
 * its merge keys, and composes them with Mesh's federation composer. No config file or build step is involved.
 *
 * @param sources - The sources, each with a unique name.
 * @param [options] - The fetch for OpenAPI documents, and cross-source fields.
 * @returns The supergraph.
 * @throws {SupergraphCompositionError} When a source fails to load or the sources do not compose.
 */
export async function composeSupergraph(sources: readonly Source[], options: ComposeOptions = {}): Promise<Supergraph> {
  const fetchFn = options.fetch ?? fetch;
  const context: LoadContext = {
    fetch: (url, init) => fetchFn(url, init),
    cwd: process.cwd(),
    logger: meshLogger,
  };
  const loaded = await Promise.all(sources.map((source) => toSubgraph(source, context)));
  const loadIssues = loaded.filter((one): one is CompositionIssue => 'code' in one);
  if (loadIssues.length > 0) {
    throw new SupergraphCompositionError(loadIssues);
  }
  const subgraphs = loaded.filter((one): one is SubgraphConfig => 'schema' in one);
  const result = composeSubgraphsSafely(subgraphs);
  if (result.errors?.length) {
    throw new SupergraphCompositionError(
      result.errors.map((error) => ({
        message: error.message,
        code: String(error.extensions.code ?? CompositionIssueCode.CompositionFailed),
      })),
    );
  }
  const sdl = options.additionalTypeDefs
    ? addAdditionalFields(result.supergraphSdl, options.additionalTypeDefs)
    : result.supergraphSdl;
  return { sdl, sources };
}

/**
 * Runs Mesh's composer, turning a transform's thrown validation error into a composition issue.
 *
 * @param subgraphs - The loaded subgraphs.
 * @returns The composer's result.
 * @throws {SupergraphCompositionError} When a transform throws.
 */
function composeSubgraphsSafely(subgraphs: SubgraphConfig[]): ReturnType<typeof composeSubgraphs> {
  try {
    return composeSubgraphs(subgraphs);
  } catch (error) {
    throw new SupergraphCompositionError([
      { message: errorMessage(error), code: CompositionIssueCode.TransformFailed },
    ]);
  }
}
