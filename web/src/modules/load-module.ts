import type { ComponentType } from 'react';
import { fetchText } from '@/core/gql';
import { SHARED_MODULES } from './shared-modules.ts';

/** A module's component: it takes no props. */
export type ModuleComponent = ComponentType<Record<string, never>>;

/** The CommonJS shape esbuild writes the module as. */
interface ModuleRecord {
  exports: { default?: unknown };
}

/** Each code URL's component, loading or loaded. A URL names one version, so it never goes stale. */
const LOADED = new Map<string, Promise<ModuleComponent>>();

/**
 * Resolves one of the module's imports from the shared registry.
 *
 * @param specifier - What the module imports.
 * @returns What the app has under that name.
 * @throws When the app shares nothing under that name.
 */
function requireShared(specifier: string): unknown {
  const isShared = SHARED_MODULES.has(specifier);
  if (isShared === false) {
    throw new Error(
      `This module imports "${specifier}", which Symphony does not share with modules. Import only react, symphony, @/lib/utils and the installed @/components.`,
    );
  }
  return SHARED_MODULES.get(specifier);
}

/**
 * Runs a compiled module's code and takes its default export.
 *
 * @param code - The compiled code, CommonJS-shaped.
 * @param url - Where it came from, for stack traces.
 * @returns The component.
 * @throws When the code throws as it runs, or its default export is not a component.
 */
function evaluateModule(code: string, url: string): ModuleComponent {
  const record: ModuleRecord = { exports: {} };
  // Modules are trusted like the app itself (one operator, same page), so their code runs in it unsandboxed.
  const run = new Function('require', 'module', 'exports', `${code}\n//# sourceURL=${url}`);
  run(requireShared, record, record.exports);
  const component = record.exports.default;
  if (typeof component !== 'function') {
    throw new Error(`The module at ${url} has no default export that is a React component.`);
  }
  return component as ModuleComponent;
}

/**
 * Loads a module's component from its compiled code, once per URL.
 *
 * @param url - The module version's `codeUrl`.
 * @returns The component.
 */
export function loadModule(url: string): Promise<ModuleComponent> {
  const known = LOADED.get(url);
  if (known !== undefined) {
    return known;
  }
  const loading = fetchText(url).then((code) => evaluateModule(code, url));
  // A failed load is forgotten, so a retry fetches again.
  loading.catch(() => LOADED.delete(url));
  LOADED.set(url, loading);
  return loading;
}
