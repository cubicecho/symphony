import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AddItemDocument,
  type AddItemInput,
  AddPageDocument,
  DeletePageDocument,
  type ItemFieldsFragment,
  LimitsDocument,
  MoveItemDocument,
  type PageFieldsFragment,
  PagesDocument,
  RemoveItemDocument,
  UpdateItemDocument,
  type UpdateItemInput,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';

/** A page as the app holds it. */
export type Page = PageFieldsFragment;
/** A module placed on a page. */
export type Item = ItemFieldsFragment;

/** The page that is always there, first in the list, at `/`. */
export const HOME_SLUG = 'home';

/** The one query every page view and the sidebar read: all pages, with their items. */
export const PAGES_KEY = ['pages'] as const;
const LIMITS_KEY = ['limits'] as const;

/**
 * Every page, Home first.
 *
 * @returns The query.
 */
export function usePages() {
  return useQuery({ queryKey: PAGES_KEY, queryFn: async () => (await request(PagesDocument)).pages });
}

/**
 * The numbers the server checks layouts and sources against.
 *
 * @returns The query. The limits do not change while the server runs.
 */
export function useLimits() {
  return useQuery({
    queryKey: LIMITS_KEY,
    queryFn: async () => (await request(LimitsDocument)).limits,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Puts a page the server sent back into the cached list, in place, or at the end when it is new.
 *
 * @param client - The query client.
 * @param page - The page as the server now has it.
 */
function writePage(client: QueryClient, page: Page): void {
  client.setQueryData<Page[]>(PAGES_KEY, (pages) => {
    if (pages === undefined) {
      return undefined;
    }
    const isKnown = pages.some((known) => known.slug === page.slug);
    if (isKnown) {
      return pages.map((known) => (known.slug === page.slug ? page : known));
    }
    return [...pages, page];
  });
}

/**
 * Adds a page.
 *
 * @returns The mutation, taking the title.
 */
export function useAddPage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (title: string) => (await request(AddPageDocument, { input: { title } })).addPage,
    onSuccess: (page) => writePage(client, page),
  });
}

/**
 * Deletes a page that is not Home.
 *
 * @returns The mutation, taking the slug.
 */
export function useDeletePage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => (await request(DeletePageDocument, { slug })).deletePage,
    onSuccess: (_deleted, slug) => {
      client.setQueryData<Page[]>(PAGES_KEY, (pages) => pages?.filter((page) => page.slug !== slug));
    },
  });
}

/**
 * Places a module on a page.
 *
 * @returns The mutation, taking the page, the module and its width.
 */
export function useAddItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddItemInput) => (await request(AddItemDocument, { input })).addItem,
    onSuccess: (page) => writePage(client, page),
  });
}

/**
 * Changes an item's width.
 *
 * @returns The mutation, taking the item and its new width.
 */
export function useUpdateItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateItemInput) => (await request(UpdateItemDocument, { input })).updateItem,
    onSuccess: (page) => writePage(client, page),
  });
}

/**
 * Moves an item one place earlier or later on its page.
 *
 * @returns The mutation, taking the item and -1 or 1.
 */
export function useMoveItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, offset }: { id: string; offset: number }) =>
      (await request(MoveItemDocument, { id, offset })).moveItem,
    onSuccess: (page) => writePage(client, page),
  });
}

/**
 * Takes an item off its page. The module itself is kept.
 *
 * @returns The mutation, taking the item's id.
 */
export function useRemoveItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(RemoveItemDocument, { id })).removeItem,
    onSuccess: (page) => writePage(client, page),
  });
}
