import { createContext, useContext } from 'react';

/** What the `symphony` runtime needs to know about the module it is running for. */
export interface ModuleScope {
  /** The module's id: its queries are cached, and refetched after a mutation, under it. */
  moduleId: string;
  /** Where the module's default upstream takes GraphQL documents: `/proxy/<upstreamId>`. A plain `gql` goes here. */
  proxyPath: string;
  /** Where each of the module's upstreams takes documents, by name: what a `gql.from('<name>')` document goes to. */
  proxyPaths: Readonly<Record<string, string>>;
  /** The page item the module is drawn for, whose path the page URL keeps. Absent in the editor's preview. */
  itemId?: string | undefined;
}

/** One of a module's upstreams, as the scope is built from it. */
export interface ScopeUpstream {
  name: string;
  proxyPath: string;
}

/** The module a `symphony` hook runs for. `ModuleCard` provides it around every module. */
export const ModuleContext = createContext<ModuleScope | null>(null);

/**
 * Builds a module's scope from its upstreams.
 *
 * @param moduleId - The module.
 * @param upstreams - Its upstreams, in order: the first is the default.
 * @param [itemId] - The page item it is drawn for, or undefined in the editor's preview.
 * @returns The scope. A module with no upstreams (never stored so) gets an empty default path, which no request
 * reaches: the hooks fail it first.
 */
export function moduleScopeOf(
  moduleId: string,
  upstreams: readonly ScopeUpstream[],
  itemId?: string | undefined,
): ModuleScope {
  return {
    moduleId,
    itemId,
    proxyPath: upstreams[0]?.proxyPath ?? '',
    proxyPaths: Object.fromEntries(upstreams.map((upstream) => [upstream.name, upstream.proxyPath])),
  };
}

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
