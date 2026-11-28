// The `symphony` module that module code imports (docs/module-contract.md, "The symphony runtime").
// Its exports are the contract: rename nothing here without changing the contract and the compiler.
import {
  useQueryClient,
  useMutation as useTanstackMutation,
  useQuery as useTanstackQuery,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { MS_PER_SECOND } from '@/core/consts';
import { postGraphQL, RequestError, streamGraphQL } from '@/core/gql';
import { type ModuleScope, moduleQueryPrefix, useModuleScope } from './module-context.ts';
import {
  callOnEvent,
  createReconnectPlanner,
  DEFAULT_MAX_EVENTS,
  keepLatest,
  maxEventsProblem,
} from './subscription-state.ts';

/** The first operation name in a document: `query RecentOrders(…)` gives `RecentOrders`. */
const OPERATION_NAME = /\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/;

/**
 * Where a subscription is. `idle` while `enabled` is false; `connecting` while it opens, and again while it waits to
 * reconnect after a drop; `open` while it streams; `complete` once the upstream ended it; `error` when it was refused
 * and won't be tried again.
 */
export type SubscriptionStatus = 'idle' | 'connecting' | 'open' | 'complete' | 'error';

/** What `useSubscription` takes besides the document. */
export interface SubscriptionOptions<T> {
  /** The document's variables. A change closes the stream and opens a new one. */
  variables?: Record<string, unknown> | undefined;
  /** False holds the subscription back, or closes it, until it is true. */
  enabled?: boolean | undefined;
  /** How many of the latest events `events` keeps: a whole number, 0 for none. Default 100. */
  maxEvents?: number | undefined;
  /**
   * Called with each event's `data` as it arrives: to refetch a query when a run ends, say. A throw in it lands in
   * `error` and leaves the stream open.
   */
  onEvent?: ((data: T) => void) | undefined;
}

/** What `useSubscription` hands back. */
export interface SubscriptionResult<T> {
  /** The `data` of each event so far, oldest first, at most `maxEvents` of them. */
  events: T[];
  /** The newest event's `data`. */
  latest: T | undefined;
  status: SubscriptionStatus;
  /** Why it was refused, why it last dropped, the GraphQL errors the last event carried, or what `onEvent` threw. */
  error: Error | null;
}

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

/** A document for one of the module's upstreams other than the default, as `gql.from('<name>')` makes it. */
export interface UpstreamDocument {
  /** The document's text. */
  readonly query: string;
  /** The name of the upstream it goes to. */
  readonly upstream: string;
}

/** What the hooks take: a plain `gql` document's text, which goes to the default upstream, or a `gql.from` one. */
export type Document = string | UpstreamDocument;

/**
 * Marks a GraphQL document for the module's default upstream so the compiler finds and validates it.
 *
 * @param strings - The template's text. The compiler refuses a `${…}` inside it.
 * @returns The document's text.
 */
function gqlTag(strings: TemplateStringsArray): string {
  return strings.join('');
}

/**
 * Marks a GraphQL document for another of the module's upstreams: ``gql.from('billing')`query …` ``.
 *
 * @param upstream - The upstream's name, as a string literal so the compiler can check the document against it.
 * @returns A tag that makes a document carrying its upstream.
 */
function gqlFrom(upstream: string): (strings: TemplateStringsArray) => UpstreamDocument {
  return (strings) => ({ query: strings.join(''), upstream });
}

/**
 * Marks a GraphQL document so the compiler finds and validates it. ``gql`…` `` is for the module's default upstream
 * and returns the text; ``gql.from('<name>')`…` `` is for another of its upstreams.
 */
export const gql: typeof gqlTag & { from: typeof gqlFrom } = Object.assign(gqlTag, { from: gqlFrom });

/** Where one document goes, and its text. */
interface Routed {
  query: string;
  /** The upstream's name, or null for the default. */
  upstream: string | null;
  proxyPath: string | undefined;
}

/**
 * Works out where a document goes.
 *
 * @param document - A `gql` or `gql.from` document.
 * @param scope - The module's scope.
 * @returns Its text, its upstream, and the proxy path, undefined when the module has no upstream by that name.
 */
function route(document: Document, scope: ModuleScope): Routed {
  if (typeof document === 'string') {
    return { query: document, upstream: null, proxyPath: scope.proxyPath === '' ? undefined : scope.proxyPath };
  }
  return { query: document.query, upstream: document.upstream, proxyPath: scope.proxyPaths[document.upstream] };
}

/**
 * Explains a document whose upstream the module doesn't list.
 *
 * @param upstream - The upstream's name, or null for the default.
 * @returns The error.
 */
function missingUpstreamError(upstream: string | null): Error {
  const which = upstream === null ? 'a default upstream' : `an upstream named "${upstream}"`;
  return new Error(`This module has no ${which}. Add it to the module's upstreams.`);
}

/**
 * Sends a routed document through Symphony's proxy.
 *
 * @typeParam T - What the document's `data` holds.
 * @param routed - The document and where it goes.
 * @param variables - Its variables.
 * @returns The `data`.
 * @throws When the module has no such upstream, or the request fails.
 */
function send<T>(routed: Routed, variables: Record<string, unknown> | undefined): Promise<T> {
  if (routed.proxyPath === undefined) {
    return Promise.reject(missingUpstreamError(routed.upstream));
  }
  return postGraphQL<T>(routed.proxyPath, {
    query: routed.query,
    variables,
    operationName: operationNameOf(routed.query),
  });
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
 * Runs a query against the document's upstream, through Symphony's proxy.
 *
 * @typeParam T - What the query's `data` holds.
 * @param document - A `gql` or `gql.from` document.
 * @param [options] - Variables, a refetch interval, and whether it may run yet.
 * @returns The data, the error, whether it is loading, and a refetch.
 */
export function useQuery<T>(document: Document, options: QueryOptions = {}): QueryResult<T> {
  const scope = useModuleScope();
  const routed = route(document, scope);
  const { variables, refetchIntervalSeconds, enabled = true } = options;
  const query = useTanstackQuery<T, Error>({
    queryKey: [...moduleQueryPrefix(scope.moduleId), routed.upstream, routed.query, variables ?? null],
    queryFn: () => send<T>(routed, variables),
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
 * Runs mutations against the document's upstream. When one succeeds, every query of this module is fetched again.
 *
 * @typeParam T - What the mutation's `data` holds.
 * @typeParam V - Its variables.
 * @param document - A `gql` or `gql.from` document.
 * @returns `mutate`, the last data and error, and whether a run is on its way.
 */
export function useMutation<T, V extends Record<string, unknown> = Record<string, unknown>>(
  document: Document,
): MutationResult<T, V> {
  const scope = useModuleScope();
  const routed = route(document, scope);
  const queryClient = useQueryClient();
  const mutation = useTanstackMutation<T, Error, V | undefined>({
    mutationFn: (variables) => send<T>(routed, variables),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: moduleQueryPrefix(scope.moduleId) }),
  });
  return {
    mutate: (variables) => mutation.mutateAsync(variables),
    data: mutation.data,
    error: mutation.error,
    isPending: mutation.isPending,
  };
}

/**
 * A subscription's state before its first event.
 *
 * @param status - Where it is.
 * @param [error] - Why, when it was refused.
 * @returns The state.
 */
function freshSubscription<T>(status: SubscriptionStatus, error: Error | null = null): SubscriptionResult<T> {
  return { events: [], latest: undefined, status, error };
}

/**
 * Follows a subscription on the document's upstream, through Symphony's proxy. It opens on mount, closes on unmount
 * or when the variables change, and completes when the upstream completes. A dropped stream reconnects with backoff;
 * one the server refused, or that completed, does not.
 *
 * @typeParam T - What each event's `data` holds.
 * @param document - A `gql` or `gql.from` subscription document.
 * @param [options] - Variables, whether it may run yet, how many events to keep, and a callback per event.
 * @returns The events so far, the latest, the status and the last error.
 */
export function useSubscription<T>(document: Document, options: SubscriptionOptions<T> = {}): SubscriptionResult<T> {
  const scope = useModuleScope();
  const { query, upstream, proxyPath } = route(document, scope);
  const { variables, enabled = true, maxEvents = DEFAULT_MAX_EVENTS, onEvent } = options;
  // Variables arrive as a fresh object each render, so the stream follows their JSON, not their identity.
  const variablesKey = JSON.stringify(variables ?? null);
  const [state, setState] = useState<SubscriptionResult<T>>(() => freshSubscription(enabled ? 'connecting' : 'idle'));
  // The newest callback, read when an event arrives, so passing a new function doesn't reopen the stream.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (enabled === false) {
      setState(freshSubscription('idle'));
      return;
    }
    if (proxyPath === undefined) {
      setState(freshSubscription('error', missingUpstreamError(upstream)));
      return;
    }
    const badMaxEvents = maxEventsProblem(maxEvents);
    if (badMaxEvents !== null) {
      setState(freshSubscription('error', badMaxEvents));
      return;
    }
    const closer = new AbortController();
    const operation = {
      query,
      variables: JSON.parse(variablesKey) ?? undefined,
      operationName: operationNameOf(query),
    };
    const reconnects = createReconnectPlanner();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    setState(freshSubscription('connecting'));

    const connect = async (): Promise<void> => {
      try {
        await streamGraphQL<T>(
          proxyPath,
          operation,
          {
            onOpen: () => {
              setState((current) => ({ ...current, status: 'open', error: null }));
            },
            onNext: (result) => {
              reconnects.received();
              const errors = result.errors ?? [];
              const error = errors.length > 0 ? new RequestError(errors) : null;
              const data = result.data;
              if (data === undefined || data === null) {
                setState((current) => ({ ...current, error }));
                return;
              }
              setState((current) => ({
                events: keepLatest(current.events, data, maxEvents),
                latest: data,
                status: 'open',
                error,
              }));
              const thrown = callOnEvent(onEventRef.current, data);
              if (thrown !== null) {
                console.error(thrown);
                setState((current) => ({ ...current, error: thrown }));
              }
            },
          },
          closer.signal,
        );
        setState((current) => ({ ...current, status: 'complete' }));
      } catch (error) {
        if (closer.signal.aborted) {
          return;
        }
        const reason = error instanceof Error ? error : new Error(String(error));
        if (reason instanceof RequestError) {
          setState((current) => ({ ...current, status: 'error', error: reason }));
          return;
        }
        setState((current) => ({ ...current, status: 'connecting', error: reason }));
        reconnectTimer = setTimeout(() => void connect(), reconnects.dropped());
      }
    };
    void connect();
    return () => {
      closer.abort();
      clearTimeout(reconnectTimer);
    };
  }, [enabled, proxyPath, upstream, query, variablesKey, maxEvents]);

  return state;
}

export { RouteLink, type RouteState, Routes, type RouteView, useRoute } from './module-routes.tsx';
