import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AddUpstreamDocument,
  type AddUpstreamInput,
  DeleteUpstreamDocument,
  RefreshSchemaDocument,
  UpdateUpstreamDocument,
  type UpdateUpstreamInput,
  type UpstreamFieldsFragment,
  UpstreamSchemaDocument,
  UpstreamsDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { MODULES_KEY } from '@/modules/use-modules';
import { PAGES_KEY } from '@/pages/use-pages';

/** An upstream as the app holds it. */
export type Upstream = UpstreamFieldsFragment;

/** The list every upstream screen reads. */
export const UPSTREAMS_KEY = ['upstreams'] as const;

/**
 * Every upstream.
 *
 * @returns The query.
 */
export function useUpstreams() {
  return useQuery({ queryKey: UPSTREAMS_KEY, queryFn: async () => (await request(UpstreamsDocument)).upstreams });
}

/**
 * One upstream's schema as SDL, fetched only while something shows it: it can be large.
 *
 * @param id - The upstream.
 * @param enabled - Whether to fetch it now.
 * @returns The query; its data is null when the schema was never fetched.
 */
export function useUpstreamSdl(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...UPSTREAMS_KEY, id, 'sdl'],
    queryFn: async () => (await request(UpstreamSchemaDocument, { id })).upstream?.schema?.sdl ?? null,
    enabled,
  });
}

/**
 * Puts an upstream the server sent back into the cached list, in place, or at the end when it is new.
 *
 * @param client - The query client.
 * @param upstream - The upstream as the server now has it.
 */
function writeUpstream(client: QueryClient, upstream: Upstream): void {
  // An updater that hands back undefined leaves a list that was never fetched unfetched.
  client.setQueryData<Upstream[]>(UPSTREAMS_KEY, (upstreams) => {
    if (upstreams === undefined) {
      return undefined;
    }
    const isKnown = upstreams.some((known) => known.id === upstream.id);
    if (isKnown) {
      return upstreams.map((known) => (known.id === upstream.id ? upstream : known));
    }
    return [...upstreams, upstream];
  });
  // Modules and pages show the upstream's name, and the SDL query holds its schema.
  void client.invalidateQueries({ queryKey: [...UPSTREAMS_KEY, upstream.id, 'sdl'] });
  void client.invalidateQueries({ queryKey: MODULES_KEY });
  void client.invalidateQueries({ queryKey: PAGES_KEY });
}

/**
 * Adds an upstream; the server introspects it at once.
 *
 * @returns The mutation, taking the new upstream's fields.
 */
export function useAddUpstream() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddUpstreamInput) => (await request(AddUpstreamDocument, { input })).addUpstream,
    onSuccess: (upstream) => writeUpstream(client, upstream),
  });
}

/**
 * Changes an upstream's name, URL or headers.
 *
 * @returns The mutation, taking the upstream's id and new fields.
 */
export function useUpdateUpstream() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateUpstreamInput) => (await request(UpdateUpstreamDocument, { input })).updateUpstream,
    onSuccess: (upstream) => writeUpstream(client, upstream),
  });
}

/**
 * Introspects an upstream again.
 *
 * @returns The mutation, taking the upstream's id.
 */
export function useRefreshSchema() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(RefreshSchemaDocument, { id })).refreshSchema,
    onSuccess: (upstream) => writeUpstream(client, upstream),
  });
}

/**
 * Deletes an upstream, with its modules and their places on pages.
 *
 * @returns The mutation, taking the upstream's id.
 */
export function useDeleteUpstream() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(DeleteUpstreamDocument, { id })).deleteUpstream,
    onSuccess: (_deleted, id) => {
      client.setQueryData<Upstream[]>(UPSTREAMS_KEY, (upstreams) =>
        upstreams?.filter((upstream) => upstream.id !== id),
      );
      void client.invalidateQueries({ queryKey: MODULES_KEY });
      void client.invalidateQueries({ queryKey: PAGES_KEY });
    },
  });
}
