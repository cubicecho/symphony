// Field conflicts: a field of a merged type that more than one source provides, once renamed. Every merged type is
// @shareable, so composition accepts them, and the gateway then reads the field from whichever source its plan
// reaches first. Each conflict is resolved to one source where it can be, and only that source keeps the field: the
// other sources' copies are hidden before composing (`hiddenFields` on a source, compose.ts).
//
// Who serves a conflicting field, first rule that applies:
// 1. The concept's `priority` for it: the member it names, when that member provides it.
// 2. A shared concept field: the concept subgraph, whose value comes from the first member (in definition order)
//    that has the entity, the same value drift is measured against.
// 3. An owned concept field: its owner, when the owner provides it.
// 4. Nobody: the gateway picks.
// 1 and 4 are reported as warnings (1 marked with its priority, so a user sees what it shadows); 2 and 3 are what the
// definition already says and are not. Warnings never stop a concept being served or the supergraph composing.
import type { GraphQLSchema } from 'graphql';
import { isInterfaceType, isObjectType } from 'graphql';
import { type Concept, FieldMode, memberApp } from '../concepts/concept.ts';
import type { ConceptProblem } from '../concepts/validate.ts';
import type { WiringService } from '../core/services.ts';
import { CONCEPT_SOURCE_NAME, deriveWiring, type SourceWiring } from './wiring.ts';

/** How a conflict was resolved to one source. */
export const ConflictResolution = {
  /** The concept's `priority` names the member. */
  Priority: 'priority',
  /** A shared concept field, served by the concept subgraph. */
  Shared: 'shared',
  /** An owned concept field, served by its owner. */
  Owner: 'owner',
} as const;
export type ConflictResolution = (typeof ConflictResolution)[keyof typeof ConflictResolution];

/** A field of a merged type that more than one source provides. */
export interface FieldConflict {
  /** The concept whose type it is; null for a type that only wiring overrides merge. */
  concept: string | null;
  /** The merged type, after renames. */
  type: string;
  /** The field, after renames. */
  field: string;
  /** Every source that provides it, by Symphony name, sorted. */
  sources: string[];
  /** The member app the concept's priority names for this field; null when none is set. */
  priority: string | null;
  /** The source the field is served from; null when the gateway picks. */
  servedBy: string | null;
  /** Why `servedBy` serves it; null when nothing resolves it. */
  resolution: ConflictResolution | null;
  message: string;
}

/** One source, as conflicts are found across them. */
export interface ConflictSource {
  /** The upstream's name, or CONCEPT_SOURCE_NAME. */
  name: string;
  /** Its schema before renames. */
  schema: GraphQLSchema;
  /** Its effective wiring; a source without merge keys merges nothing. */
  wiring: Pick<SourceWiring, 'renames' | 'mergeKeys'> | undefined;
}

/**
 * Lists the fields a source gives a merged type once its renames apply.
 *
 * @param schema - The source's schema, before renames.
 * @param renames - Its type and field renames.
 * @param type - The merged type's name, after renames.
 * @returns The field names, after renames.
 */
export function fieldsAfterRenames(
  schema: GraphQLSchema,
  renames: Pick<SourceWiring, 'renames'>['renames'] | undefined,
  type: string,
): string[] {
  const typeRenames = renames?.types ?? {};
  const fieldRenames = renames?.fields ?? {};
  const fields = new Set<string>();
  for (const named of Object.values(schema.getTypeMap())) {
    const isComposite = isObjectType(named) || isInterfaceType(named);
    const unifiedName = typeRenames[named.name] ?? named.name;
    if (isComposite === false || unifiedName !== type) {
      continue;
    }
    for (const field of Object.keys(named.getFields())) {
      fields.add(fieldRenames[`${named.name}.${field}`] ?? field);
    }
  }
  return [...fields];
}

/**
 * Decides who serves one conflicting field of a concept's type.
 *
 * @param concept - The concept, or undefined for a type no concept defines.
 * @param field - The field.
 * @param sources - The sources that provide it.
 * @returns The serving source and why, or nulls.
 */
function resolve(
  concept: Concept | undefined,
  field: string,
  sources: readonly string[],
): Pick<FieldConflict, 'priority' | 'servedBy' | 'resolution'> {
  const upstreamOf = (app: string) => concept?.members.find((member) => memberApp(member) === app)?.upstream;
  const priority = concept?.priority?.[field] ?? null;
  const unresolved = { priority, servedBy: null, resolution: null };
  if (priority !== null) {
    const chosen = upstreamOf(priority);
    const isProvided = chosen !== undefined && sources.includes(chosen);
    return isProvided ? { priority, servedBy: chosen, resolution: ConflictResolution.Priority } : unresolved;
  }
  const declared = concept?.fields.find((one) => one.name === field);
  if (declared?.mode === FieldMode.Shared && sources.includes(CONCEPT_SOURCE_NAME)) {
    return { priority, servedBy: CONCEPT_SOURCE_NAME, resolution: ConflictResolution.Shared };
  }
  const owner = declared?.mode === FieldMode.Owned ? upstreamOf(declared.owner) : undefined;
  if (owner !== undefined && sources.includes(owner)) {
    return { priority, servedBy: owner, resolution: ConflictResolution.Owner };
  }
  return unresolved;
}

/**
 * Words a conflict for the person who can resolve it.
 *
 * @param conflict - The conflict, without its message.
 * @returns The message.
 */
function messageOf(conflict: Omit<FieldConflict, 'message'>): string {
  const coordinate = `${conflict.type}.${conflict.field}`;
  const provided = `${coordinate} comes from ${conflict.sources.join(', ')}`;
  if (conflict.servedBy !== null) {
    const ignored = conflict.sources.filter((source) => source !== conflict.servedBy).join(', ');
    const why =
      conflict.resolution === ConflictResolution.Priority ? `priority.${conflict.field} says so` : 'by default';
    return `${provided}; it is served from ${conflict.servedBy} because ${why}, and ${ignored} are ignored for it.`;
  }
  if (conflict.priority !== null) {
    return `${provided}; priority.${conflict.field} names ${conflict.priority}, which does not provide it as composed, so the gateway picks a source.`;
  }
  if (conflict.concept === null) {
    return `${provided}; the gateway serves whichever its plan reaches first. Rename it in all but one source's wiring.`;
  }
  return `${provided}; the gateway serves whichever its plan reaches first. Set priority.${conflict.field} in the ${conflict.concept} concept to the member that should win.`;
}

/**
 * Orders two names by code point, the same on every machine.
 *
 * @param a - One name.
 * @param b - Another.
 * @returns Negative, zero or positive, as `Array.prototype.sort` expects.
 */
function compareNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Finds every non-key field of a merged type that more than one source provides, and who serves each.
 *
 * @param concepts - The servable concepts, whose priorities and fields decide.
 * @param sources - Every source that will be composed, with its effective wiring.
 * @returns The conflicts, by type then field.
 */
export function findFieldConflicts(concepts: readonly Concept[], sources: readonly ConflictSource[]): FieldConflict[] {
  const mergedTypes = [
    ...new Set(sources.flatMap((source) => (source.wiring?.mergeKeys ?? []).map((key) => key.type))),
  ];
  const conflicts: FieldConflict[] = [];
  for (const type of mergedTypes.sort(compareNames)) {
    const merging = sources.filter((source) => source.wiring?.mergeKeys.some((key) => key.type === type) === true);
    const keyFields = new Set(
      merging.flatMap(
        (source) => source.wiring?.mergeKeys.filter((key) => key.type === type).map((key) => key.keyField) ?? [],
      ),
    );
    const providers = new Map<string, string[]>();
    for (const source of merging) {
      for (const field of fieldsAfterRenames(source.schema, source.wiring?.renames, type)) {
        providers.set(field, [...(providers.get(field) ?? []), source.name]);
      }
    }
    const concept = concepts.find((one) => one.name === type);
    for (const [field, names] of [...providers].sort(([a], [b]) => compareNames(a, b))) {
      const isShared = names.length > 1 && keyFields.has(field) === false && field.startsWith('__') === false;
      if (isShared === false) {
        continue;
      }
      const sorted = [...names].sort(compareNames);
      const conflict = {
        concept: concept?.name ?? null,
        type,
        field,
        sources: sorted,
        ...resolve(concept, field, sorted),
      };
      conflicts.push({ ...conflict, message: messageOf(conflict) });
    }
  }
  return conflicts;
}

/**
 * Tells whether a conflict is reported as a warning: the gateway picks, or a priority shadows other sources.
 *
 * @param conflict - A conflict.
 * @returns False for the defaults a concept's fields already imply.
 */
export function isWarned(conflict: FieldConflict): boolean {
  return conflict.resolution === null || conflict.resolution === ConflictResolution.Priority;
}

/**
 * Lists the warnings about one concept's type, from the wiring as it would compose now.
 *
 * @param wiring - The wiring service.
 * @param concept - The concept's name.
 * @returns Its warned conflicts.
 */
export async function conceptWarnings(
  wiring: Pick<WiringService, 'effective'>,
  concept: string,
): Promise<FieldConflict[]> {
  const { conflicts } = await wiring.effective();
  return conflicts.filter((conflict) => conflict.concept === concept && isWarned(conflict));
}

/**
 * Lists the fields one source must leave out because another source serves them.
 *
 * @param conflicts - From findFieldConflicts.
 * @param source - The source's Symphony name.
 * @returns Field names after renames, by merged type; empty when it keeps every field.
 */
export function hiddenFieldsOf(conflicts: readonly FieldConflict[], source: string): Record<string, string[]> {
  const hidden: Record<string, string[]> = {};
  for (const conflict of conflicts) {
    const isHidden = conflict.servedBy !== null && conflict.servedBy !== source && conflict.sources.includes(source);
    if (isHidden) {
      hidden[conflict.type] = [...(hidden[conflict.type] ?? []), conflict.field];
    }
  }
  return hidden;
}

/**
 * Checks that each member a concept's priority names provides that field on the concept's type, as its generated
 * wiring renames it.
 *
 * @param concept - A concept whose documents validated.
 * @param schemas - Each upstream's schema, by upstream name.
 * @returns One problem per priority whose member does not provide the field.
 */
export function priorityProblems(concept: Concept, schemas: ReadonlyMap<string, GraphQLSchema>): ConceptProblem[] {
  const entries = Object.entries(concept.priority ?? {});
  if (entries.length === 0) {
    return [];
  }
  const { wiring } = deriveWiring([concept], schemas);
  return entries.flatMap(([field, app]) => {
    const member = concept.members.find((one) => memberApp(one) === app);
    const schema = member === undefined ? undefined : schemas.get(member.upstream);
    if (member === undefined || schema === undefined) {
      return [];
    }
    const renames = wiring.find((one) => one.upstream === member.upstream)?.renames;
    const provided = fieldsAfterRenames(schema, renames, concept.name);
    if (provided.includes(field)) {
      return [];
    }
    const message = `priority.${field}: ${app} gives ${concept.name} no field "${field}"; it gives ${provided.sort(compareNames).join(', ')}.`;
    return [{ concept: concept.name, member: member.upstream, operation: null, message, line: null, column: null }];
  });
}
