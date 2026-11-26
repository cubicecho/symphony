// The wiring the unified gateway composes with: generated from the servable concepts, with users' overrides applied.
//
// Overrides are keyed by source name, because that is what wiring names. An upstream's override follows it through
// a rename (key and `upstream` both) and is deleted when the upstream is, so it never lands on a different upstream
// that later takes the name. The concept subgraph's override has no upstream row and is only ever cleared by hand.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { badInput, notFound } from '../core/errors.ts';
import type { EventFeed } from '../core/events.ts';
import {
  type ConceptService,
  type SourcesChange,
  UpstreamChange,
  type UpstreamEvent,
  type UpstreamService,
  type WiringService,
  type WiringState,
} from '../core/services.ts';
import type { Database } from '../db/client.ts';
import { wiringOverrides } from '../db/schema.ts';
import { schemasByName } from './concept-service.ts';
import { applyWiringOverrides, CONCEPT_SOURCE_NAME, deriveWiring, type WiringOverride } from './wiring.ts';

/** What the service talks to, and the wiring functions it runs (tests pass fakes while wiring.ts is a stub). */
export interface WiringServiceDeps {
  db: Database;
  concepts: ConceptService;
  upstreams: UpstreamService;
  /** Told after every override set or cleared. */
  changes?: EventFeed<SourcesChange>;
  /** Followed so overrides move with renames and go with removed upstreams. */
  upstreamEvents?: EventFeed<UpstreamEvent>;
  /** @defaultValue wiring.ts's deriveWiring */
  deriveWiring?: typeof deriveWiring;
  /** @defaultValue wiring.ts's applyWiringOverrides */
  applyWiringOverrides?: typeof applyWiringOverrides;
}

/** A rename map: a null value removes the generated rename. */
const renameMap = z.record(z.string().min(1), z.string().min(1).nullable());

/** `SourceType.field`, as field renames are keyed. */
const FIELD_COORDINATE = /^[^.\s]+\.[^.\s]+$/;

/**
 * The shape a submitted override must have. A stand-in for wiring.ts's `wiringOverrideSchema` until it exports one.
 */
const wiringOverrideInput = z
  .object({
    upstream: z.string().min(1).optional(),
    renames: z
      .object({
        types: renameMap.optional(),
        fields: renameMap
          .refine(
            (fields) => Object.keys(fields).every((coordinate) => FIELD_COORDINATE.test(coordinate)),
            'Field renames are keyed `SourceType.field`.',
          )
          .optional(),
      })
      .strict()
      .optional(),
    mergeKeys: z
      .array(
        z
          .object({
            type: z.string().min(1),
            keyField: z.string().min(1),
            lookupField: z.string().min(1),
            keyArg: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    removeMergeKeys: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Checks a submitted override and names it for its source.
 *
 * @param source - The source it is for.
 * @param value - Untrusted JSON.
 * @returns The override, its `upstream` set to the source.
 * @throws BAD_USER_INPUT naming every issue, or when its `upstream` names another source.
 */
function parseOverride(source: string, value: unknown): WiringOverride {
  const parsed = wiringOverrideInput.safeParse(value);
  if (parsed.success === false) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(override)'}: ${issue.message}`);
    throw badInput(`The wiring override is not valid: ${issues.join(' ')}`, { issues });
  }
  const namesOtherSource = parsed.data.upstream !== undefined && parsed.data.upstream !== source;
  if (namesOtherSource) {
    throw badInput(`The override names "${parsed.data.upstream}" but is set for "${source}"; leave \`upstream\` out.`);
  }
  return { ...parsed.data, upstream: source };
}

/**
 * Builds the wiring service, and makes overrides follow their upstreams.
 *
 * @param deps - The database, concepts, upstreams, feeds and wiring functions.
 * @returns The service.
 */
export function createWiringService(deps: WiringServiceDeps): WiringService {
  const { db } = deps;
  const derive = deps.deriveWiring ?? deriveWiring;
  const apply = deps.applyWiringOverrides ?? applyWiringOverrides;

  const effective = async (): Promise<WiringState> => {
    const [records, upstreams, rows] = await Promise.all([
      deps.concepts.list(),
      deps.upstreams.list(),
      db.select().from(wiringOverrides).orderBy(wiringOverrides.source),
    ]);
    const servable = records.flatMap((record) =>
      record.concept !== null && record.problems.length === 0 ? [record.concept] : [],
    );
    // With nothing to generate from and nothing overridden there is no wiring, so neither function needs to run.
    const derived = servable.length === 0 ? { wiring: [], problems: [] } : derive(servable, schemasByName(upstreams));
    const overrides = rows.map((row) => row.override);
    const isUnwired = derived.wiring.length === 0 && overrides.length === 0;
    return { wiring: isUnwired ? [] : apply(derived.wiring, overrides), problems: derived.problems };
  };

  const find = async (source: string) => {
    const { wiring } = await effective();
    return wiring.find((one) => one.upstream === source) ?? null;
  };

  /**
   * Refuses a source that is neither an upstream nor the concept subgraph.
   *
   * @param source - The name given.
   * @throws NOT_FOUND.
   */
  const requireSource = async (source: string): Promise<void> => {
    const isConceptSource = source === CONCEPT_SOURCE_NAME;
    const upstream = isConceptSource ? null : await deps.upstreams.find(source);
    const isKnown = isConceptSource || upstream?.name === source;
    if (isKnown === false) {
      throw notFound(`There is no source "${source}": name an upstream, or "${CONCEPT_SOURCE_NAME}" for the concepts.`);
    }
  };

  deps.upstreamEvents?.subscribe(async (event) => {
    const isRename = event.change === UpstreamChange.Updated && event.name !== event.previousName;
    if (isRename) {
      const [row] = await db.select().from(wiringOverrides).where(eq(wiringOverrides.source, event.previousName));
      if (row !== undefined) {
        // A row under the new name can only be a stale one no upstream owns; the renamed upstream's own wins.
        await db.delete(wiringOverrides).where(eq(wiringOverrides.source, event.name));
        await db
          .update(wiringOverrides)
          .set({ source: event.name, override: { ...row.override, upstream: event.name } })
          .where(eq(wiringOverrides.source, event.previousName));
      }
    }
    if (event.change === UpstreamChange.Removed) {
      await db.delete(wiringOverrides).where(eq(wiringOverrides.source, event.name));
    }
  });

  return {
    effective,
    find,

    setOverride: async (source, value) => {
      await requireSource(source);
      const override = parseOverride(source, value);
      await db
        .insert(wiringOverrides)
        .values({ source, override })
        .onConflictDoUpdate({ target: wiringOverrides.source, set: { override, updatedAt: new Date() } });
      await deps.changes?.emit({ reason: `wiring override for ${source} set` });
      const wiring = await find(source);
      if (wiring === null) {
        throw new Error(`applyWiringOverrides left out the override for ${source}.`);
      }
      return wiring;
    },

    clearOverride: async (source) => {
      const removed = await db.delete(wiringOverrides).where(eq(wiringOverrides.source, source)).returning();
      const wasSet = removed.length > 0;
      if (wasSet) {
        await deps.changes?.emit({ reason: `wiring override for ${source} cleared` });
      }
      return wasSet;
    },
  };
}
