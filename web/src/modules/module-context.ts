import { createContext, useContext } from 'react';

/** What the `symphony` runtime needs to know about the module it is running for. */
export interface ModuleScope {
  /** The module's id: its queries are cached, and refetched after a mutation, under it. */
  moduleId: string;
  /** Where this module's upstream takes GraphQL documents: `/proxy/<upstreamId>`. */
  proxyPath: string;
}

/** The module a `symphony` hook runs for. `ModuleCard` provides it around every module. */
export const ModuleContext = createContext<ModuleScope | null>(null);

/**
 * Reads the module a hook runs for.
 *
 * @returns The scope `ModuleCard` provides.
 * @throws When called outside a module card: the hooks have no upstream to send to.
 */
export function useModuleScope(): ModuleScope {
  const scope = useContext(ModuleContext);
  if (scope === null) {
    throw new Error('The symphony hooks only work inside a module placed on a page or previewed in its editor.');
  }
  return scope;
}

/**
 * The query key every query of one module starts with.
 *
 * @param moduleId - The module.
 * @returns The key prefix a mutation's success invalidates.
 */
export function moduleQueryPrefix(moduleId: string): readonly ['module-data', string] {
  return ['module-data', moduleId];
}
