// What compiling a module produces. The MCP door, the admin API and the module store all speak these
// shapes, so an agent and a person see the same errors.
import type { GraphQLSchema } from 'graphql';

/** Which step of the compile found a problem. */
export const CompileStage = {
  /** The file does not parse, or has no default export. */
  Source: 'SOURCE',
  /** It imports something modules may not use. */
  Imports: 'IMPORTS',
  /** A `gql` document does not parse or does not validate against the upstream's schema. */
  Graphql: 'GRAPHQL',
  /** esbuild could not turn it into browser code. */
  Transform: 'TRANSFORM',
} as const;
export type CompileStage = (typeof CompileStage)[keyof typeof CompileStage];

/** One problem, placed in the TSX source when it has a place. Lines and columns count from 1. */
export interface CompileError {
  stage: CompileStage;
  message: string;
  line: number | null;
  column: number | null;
}

/** What one compile made of a source. */
export interface CompileResult {
  /** True when there are no errors and `compiled` holds the code. */
  ok: boolean;
  errors: CompileError[];
  /** CommonJS-shaped browser code (`require`, `module.exports`), run by web/src/modules/load-module.ts. Null on failure. */
  compiled: string | null;
  /** The GraphQL documents found in the module's `gql` templates, in source order. */
  documents: string[];
}

/** What a compile needs. */
export interface CompileInput {
  /** The TSX source. */
  source: string;
  /** A name for the file in stack traces and source maps, such as the module's id. */
  fileName: string;
  /** The upstream's cached schema, or null when it was never fetched: then GraphQL documents only have to parse. */
  schema: GraphQLSchema | null;
  /** Every specifier a module may import (`react`, `symphony`, `@/components/ui/button` …). */
  allowedImports: ReadonlySet<string>;
}
