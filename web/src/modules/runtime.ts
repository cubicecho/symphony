// The `symphony` module that module code imports (docs/module-contract.md, "The symphony runtime").
// Its exports are the contract: rename nothing here without changing the contract and the compiler.
import {
  useQueryClient,
  useMutation as useTanstackMutation,
  useQuery as useTanstackQuery,
} from '@tanstack/react-query';
import { MS_PER_SECOND } from '@/core/consts';
import { postGraphQL } from '@/core/gql';
import { moduleQueryPrefix, useModuleScope } from './module-context.ts';

/** The first operation name in a document: `query RecentOrders(…)` gives `RecentOrders`. */
const OPERATION_NAME = /\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/;

/** What `useQuery` takes besides the document. */
export interface QueryOptions {
  /** The document's variables. */
  variables?: Record<string, unknown> | undefined;
  /** Fetch again this often, in seconds. Left out, the data is fetched once per mount. */
  refetchIntervalSeconds?: number | undefined;
  /** False holds the query back until it is true. */
  enabled?: boolean | undefined;
}

/** What `useQuery` hands back. */
export interface QueryResult<T> {
  /** The query's `data`, once it has arrived. */
  data: T | undefined;
  /** The failure: the upstream's GraphQL errors joined, or why it could not be reached. */
  error: Error | null;
  /** True while the first answer is on its way. */
  isLoading: boolean;
  /** Fetches the query again. */
  refetch: () => void;
  /** True until the first answer arrives. Beyond the contract, so the result fits cubeui's `LoadState` `query`. */
  isPending: boolean;
  /** True when the last fetch failed. Beyond the contract, for `LoadState` too. */
  isError: boolean;
}

/** What `useMutation` hands back. */
export interface MutationResult<T, V> {
  /** Runs the mutation. Resolves with its `data`; rejects with the same error `error` then holds. */
  mutate: (variables?: V) => Promise<T>;
  /** The last successful run's `data`. */
  data: T | undefined;
  /** The last run's failure. */
  error: Error | null;
  /** True while a run is on its way. */
  isPending: boolean;
}

/**
 * Marks a GraphQL document so the compiler finds and validates it.
 *
 * @param strings - The template's text. The compiler refuses a `${…}` inside it.
 * @returns The document's text.
 */
export function gql(strings: TemplateStringsArray): string {
  return strings.join('');
}

/**
 * Finds the name of a document's first operation.
 *
 * @param document - The document's text.
 * @returns Its name, or null for an anonymous operation.
 */
function operationNameOf(document: string): string | null {
  return OPERATION_NAME.exec(document)?.[1] ?? null;
}

/**
 * Runs a query against the module's upstream, through Symphony's proxy.
 *
 * @typeParam T - What the query's `data` holds.
 * @param document - A `gql` document.
 * @param [options] - Variables, a refetch interval, and whether it may run yet.
 * @returns The data, the error, whether it is loading, and a refetch.
 */
export function useQuery<T>(document: string, options: QueryOptions = {}): QueryResult<T> {
  const { moduleId, proxyPath } = useModuleScope();
  const { variables, refetchIntervalSeconds, enabled = true } = options;
  const query = useTanstackQuery<T, Error>({
    queryKey: [...moduleQueryPrefix(moduleId), document, variables ?? null],
    queryFn: () => postGraphQL<T>(proxyPath, { query: document, variables, operationName: operationNameOf(document) }),
    enabled,
    refetchInterval: refetchIntervalSeconds === undefined ? false : refetchIntervalSeconds * MS_PER_SECOND,
  });
  return {
    data: query.data,
    error: query.error,
    isLoading: query.isLoading,
    refetch: () => void query.refetch(),
    isPending: query.isPending,
    isError: query.isError,
  };
}

/**
 * Runs mutations against the module's upstream. When one succeeds, every query of this module is fetched again.
 *
 * @typeParam T - What the mutation's `data` holds.
 * @typeParam V - Its variables.
 * @param document - A `gql` document.
 * @returns `mutate`, the last data and error, and whether a run is on its way.
 */
export function useMutation<T, V extends Record<string, unknown> = Record<string, unknown>>(
  document: string,
): MutationResult<T, V> {
  const { moduleId, proxyPath } = useModuleScope();
  const queryClient = useQueryClient();
  const mutation = useTanstackMutation<T, Error, V | undefined>({
    mutationFn: (variables) =>
      postGraphQL<T>(proxyPath, { query: document, variables, operationName: operationNameOf(document) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: moduleQueryPrefix(moduleId) }),
  });
  return {
    mutate: (variables) => mutation.mutateAsync(variables),
    data: mutation.data,
    error: mutation.error,
    isPending: mutation.isPending,
  };
}
