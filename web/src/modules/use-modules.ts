import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CompileErrorFieldsFragment,
  DeleteModuleDocument,
  ModuleDocument,
  type ModuleFieldsFragment,
  type ModuleSummaryFieldsFragment,
  ModulesDocument,
  SaveModuleDocument,
  type SaveModuleInput,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { PAGES_KEY } from '@/pages/use-pages';

/** A module as lists and pages hold it: no source. */
export type ModuleSummary = ModuleSummaryFieldsFragment;
/** A module with its source and compile errors, as the editor holds it. */
export type ModuleDetail = ModuleFieldsFragment;
/** One problem the compiler found. */
export type CompileError = CompileErrorFieldsFragment;

/** The list of every module. */
export const MODULES_KEY = ['modules'] as const;

/**
 * The key one module's detail is cached under.
 *
 * @param id - The module.
 * @returns Its key, under MODULES_KEY so invalidating the list reaches it too.
 */
function moduleKey(id: string) {
  return [...MODULES_KEY, id] as const;
}

/**
 * Every module.
 *
 * @returns The query.
 */
export function useModules() {
  return useQuery({ queryKey: MODULES_KEY, queryFn: async () => (await request(ModulesDocument)).modules });
}

/**
 * One module, with its source and errors.
 *
 * @param id - The module.
 * @returns The query; its data is null when there is no such module.
 */
export function useModule(id: string) {
  return useQuery({ queryKey: moduleKey(id), queryFn: async () => (await request(ModuleDocument, { id })).module });
}

/**
 * Saves a module and compiles it. A module that fails to compile is still saved, with its errors.
 *
 * @returns The mutation, taking the module's fields (no id to create one).
 */
export function useSaveModule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveModuleInput) => (await request(SaveModuleDocument, { input })).saveModule,
    onSuccess: (saved) => {
      client.setQueryData(moduleKey(saved.id), saved);
      void client.invalidateQueries({ queryKey: MODULES_KEY, exact: true });
      // Pages draw the module's latest version.
      void client.invalidateQueries({ queryKey: PAGES_KEY });
    },
  });
}

/**
 * Deletes a module, and its places on pages.
 *
 * @returns The mutation, taking the module's id.
 */
export function useDeleteModule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(DeleteModuleDocument, { id })).deleteModule,
    onSuccess: (_deleted, id) => {
      client.removeQueries({ queryKey: moduleKey(id) });
      client.setQueryData<ModuleSummary[]>(MODULES_KEY, (modules) => modules?.filter((module) => module.id !== id));
      void client.invalidateQueries({ queryKey: PAGES_KEY });
    },
  });
}
