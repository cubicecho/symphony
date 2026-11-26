// Wiring: the renames and merge keys that line each source up with the unified entities before composition.
// Concepts generate it (a member's fetch document says which type is the entity, which aliases rename its fields,
// and which root field looks it up by id). Users can define wiring for any upstream, and edit the generated
// wiring, through overrides stored beside it: the effective wiring is the generated one with the overrides applied.
import type { GraphQLSchema } from 'graphql';
import type { Concept } from '../concepts/concept.ts';
import type { MergeKey, SourceRenames } from './sources.ts';

/** The name the generated concept subgraph is composed under. Upstream names may not use it. */
export const CONCEPT_SOURCE_NAME = 'symphony_concepts';

/** The id field every concept's entity is merged on, in every source. */
export const CONCEPT_ID_FIELD = 'id';

/** One source's wiring. */
export interface SourceWiring {
  /** The upstream's name, or CONCEPT_SOURCE_NAME. */
  upstream: string;
  renames: Required<SourceRenames>;
  mergeKeys: MergeKey[];
}

/**
 * A user's edit to one source's wiring. A rename set to null removes the generated one; a merge key replaces the
 * generated key for the same type, and `removeMergeKeys` drops generated keys by type.
 */
export interface WiringOverride {
  upstream: string;
  renames?: {
    types?: Readonly<Record<string, string | null>>;
    fields?: Readonly<Record<string, string | null>>;
  };
  mergeKeys?: readonly MergeKey[];
  removeMergeKeys?: readonly string[];
}

/** Where one effective entry came from. */
export type WiringOrigin = 'generated' | 'override';

/** A source's wiring as served, with what produced it. */
export interface EffectiveWiring extends SourceWiring {
  /** Null when no concept generates wiring for this source. */
  generated: SourceWiring | null;
  /** Null when the user has not edited this source's wiring. */
  override: WiringOverride | null;
  /** Origin per entry: keys are `type:<Source>`, `field:<Source.field>` and `key:<Type>`. */
  origins: Readonly<Record<string, WiringOrigin>>;
}

/** Something that stops a concept's wiring from being generated, or two concepts' wiring from agreeing. */
export interface WiringProblem {
  upstream: string;
  /** The concept whose member produced it, when one did. */
  concept: string | null;
  message: string;
}

/** The generated wiring for a set of concepts, including the concept subgraph's own. */
export interface DerivedWiring {
  wiring: SourceWiring[];
  problems: WiringProblem[];
}

/**
 * Generates the wiring that merges every concept's members into one entity per concept.
 *
 * @param concepts - Parsed concepts.
 * @param schemas - Each member upstream's cached schema, by upstream name.
 * @returns One wiring per upstream any concept uses, plus the concept subgraph's, and what could not be derived.
 */
export function deriveWiring(
  _concepts: readonly Concept[],
  _schemas: ReadonlyMap<string, GraphQLSchema>,
): DerivedWiring {
  throw new Error('deriveWiring is not implemented yet.');
}

/**
 * Applies users' overrides to the generated wiring. An override for an upstream no concept uses defines its
 * wiring from nothing.
 *
 * @param generated - From deriveWiring.
 * @param overrides - As stored, at most one per upstream.
 * @returns The effective wiring, one per upstream that has generated wiring or an override.
 */
export function applyWiringOverrides(
  _generated: readonly SourceWiring[],
  _overrides: readonly WiringOverride[],
): EffectiveWiring[] {
  throw new Error('applyWiringOverrides is not implemented yet.');
}
