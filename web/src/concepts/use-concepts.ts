import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ClearWiringOverrideDocument,
  ConceptDocument,
  type ConceptFieldsFragment,
  ConceptsDocument,
  RemoveConceptDocument,
  SaveConceptDocument,
  SetWiringOverrideDocument,
  SourceWiringDocument,
  type SourceWiringFieldsFragment,
  UnifiedStatusDocument,
  type UnifiedStatusQuery,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import type { WiringOverrideInput } from './wiring-rows.ts';

/** A concept as the app holds it. */
export type Concept = ConceptFieldsFragment;

/** One source's effective wiring. */
export type SourceWiring = SourceWiringFieldsFragment;

/** The unified API's state. */
export type UnifiedStatus = UnifiedStatusQuery['unifiedStatus'];

/** Every query about concepts, wiring and the unified API starts with this key, so one change refreshes them all. */
export const UNIFIED_KEY = ['unified'] as const;
const CONCEPTS_KEY = [...UNIFIED_KEY, 'concepts'] as const;
const WIRING_KEY = [...UNIFIED_KEY, 'wiring'] as const;
const STATUS_KEY = [...UNIFIED_KEY, 'status'] as const;

/** How often the status is asked again while the gateway is starting, in milliseconds. */
const STARTING_POLL_MS = 2000;
/** How often the status is asked again otherwise: a save recomposes in the background. */
const STATUS_POLL_MS = 10_000;

/**
 * Every concept, the ones that can't be served included.
 *
 * @returns The query.
 */
export function useConcepts() {
  return useQuery({ queryKey: CONCEPTS_KEY, queryFn: async () => (await request(ConceptsDocument)).concepts });
}

/**
 * One concept, by its id or its name.
 *
 * @param idOrName - Its id or its name.
 * @returns The query; its data is null when there is no such concept.
 */
export function useConcept(idOrName: string) {
  return useQuery({
    queryKey: [...CONCEPTS_KEY, idOrName],
    queryFn: async () => (await request(ConceptDocument, { idOrName })).concept,
  });
}

/**
 * The effective wiring of every source that has any.
 *
 * @returns The query.
 */
export function useSourceWiring() {
  return useQuery({
    queryKey: WIRING_KEY,
    queryFn: async () => (await request(SourceWiringDocument)).sourceWiring,
  });
}

/**
 * The unified API's state, asked again while it starts and now and then after, since compositions run in the
 * background.
 *
 * @returns The query.
 */
export function useUnifiedStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: async () => (await request(UnifiedStatusDocument)).unifiedStatus,
    refetchInterval: (query) => (query.state.data?.state === 'STARTING' ? STARTING_POLL_MS : STATUS_POLL_MS),
  });
}

/**
 * Refreshes everything about the unified API after a change to what it is composed from.
 *
 * @param client - The query client.
 */
export function invalidateUnified(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: UNIFIED_KEY });
}

/**
 * Stores a concept, replacing the one with the same name. A refusal is a `RequestError` whose `extensions.problems`
 * locates what is wrong (`conceptProblemsOf`).
 *
 * @returns The mutation, taking the definition as JSON.
 */
export function useSaveConcept() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (definition: unknown) => (await request(SaveConceptDocument, { definition })).saveConcept,
    onSuccess: () => invalidateUnified(client),
  });
}

/**
 * Removes a concept.
 *
 * @returns The mutation, taking the concept's id.
 */
export function useRemoveConcept() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(RemoveConceptDocument, { id })).removeConcept,
    onSuccess: (_removed, id) => {
      client.setQueryData<Concept[]>(CONCEPTS_KEY, (concepts) => concepts?.filter((concept) => concept.id !== id));
      invalidateUnified(client);
    },
  });
}

/**
 * Stores a source's wiring override, replacing any earlier one.
 *
 * @returns The mutation, taking the source and the override.
 */
export function useSetWiringOverride() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ source, override }: { source: string; override: WiringOverrideInput }) =>
      (await request(SetWiringOverrideDocument, { source, override })).setWiringOverride,
    onSuccess: () => invalidateUnified(client),
  });
}

/**
 * Drops a source's wiring override, so it is served with the generated wiring alone.
 *
 * @returns The mutation, taking the source.
 */
export function useClearWiringOverride() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (source: string) => (await request(ClearWiringOverrideDocument, { source })).clearWiringOverride,
    onSuccess: () => invalidateUnified(client),
  });
}
