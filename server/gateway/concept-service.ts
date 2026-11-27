// The stored concepts. A save is parsed and checked against the members' cached schemas, and refused with every
// located problem; a stored concept an upstream change has broken since is still listed, with its problems now.
//
// Stored definitions follow their upstreams through a rename: each member that names the old upstream is rewritten
// to the new name, keeping its member name (`app`) so the unified API's names stay put. A removed upstream is left
// in the definitions, where it shows as a located problem until the user edits the concept.
import { eq } from 'drizzle-orm';
import type { GraphQLSchema } from 'graphql';
import type { z } from 'zod';
import { type Concept, conceptSchema } from '../concepts/concept.ts';
import { ConceptValidationError } from '../concepts/subgraph.ts';
import { type ConceptProblem, validateConcepts } from '../concepts/validate.ts';
import { UUID_PATTERN } from '../core/consts.ts';
import { badInput } from '../core/errors.ts';
import type { EventFeed } from '../core/events.ts';
import {
  type ConceptRecord,
  type ConceptService,
  type SourcesChange,
  type Upstream,
  UpstreamChange,
  type UpstreamEvent,
  type UpstreamService,
} from '../core/services.ts';
import type { Database } from '../db/client.ts';
import { concepts } from '../db/schema.ts';
import { priorityProblems } from './field-conflicts.ts';

/** What the service talks to. */
export interface ConceptServiceDeps {
  db: Database;
  /** Where member upstreams and their cached schemas are read. */
  upstreams: UpstreamService;
  /** Told after every save and remove. */
  changes?: EventFeed<SourcesChange>;
  /** Followed so definitions move with renamed upstreams. */
  upstreamEvents?: EventFeed<UpstreamEvent>;
}

type ConceptRow = typeof concepts.$inferSelect;

/**
 * Maps each upstream that has a cached schema to it, by name: what concepts are validated against.
 *
 * @param upstreams - The upstreams.
 * @returns Their schemas, by upstream name.
 */
export function schemasByName(upstreams: readonly Upstream[]): Map<string, GraphQLSchema> {
  return new Map(
    upstreams.flatMap((upstream) =>
      upstream.schema === null ? [] : [[upstream.name, upstream.schema.schema] as const],
    ),
  );
}

/**
 * Reads the name a definition gives itself, before it is parsed.
 *
 * @param definition - Untrusted JSON.
 * @returns Its `name` when that is a string, otherwise an empty string.
 */
export function nameOf(definition: unknown): string {
  const hasName = typeof definition === 'object' && definition !== null && 'name' in definition;
  return hasName && typeof definition.name === 'string' ? definition.name : '';
}

/**
 * Turns zod's issues with a definition into concept problems.
 *
 * @param definition - The definition that did not parse.
 * @param error - zod's error.
 * @returns One problem per issue, its message prefixed with where in the definition it is.
 */
function parseProblems(definition: unknown, error: z.ZodError): ConceptProblem[] {
  return error.issues.map((issue) => {
    const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
    return {
      concept: nameOf(definition),
      member: null,
      operation: null,
      message: `${where}${issue.message}`,
      line: null,
      column: null,
    };
  });
}

/**
 * Lists the members that name no upstream, or one whose schema has never been fetched.
 *
 * @param concept - A parsed concept.
 * @param upstreams - Every upstream.
 * @returns One problem per such member.
 */
function memberProblems(concept: Concept, upstreams: readonly Upstream[]): ConceptProblem[] {
  return concept.members.flatMap((member) => {
    const upstream = upstreams.find((one) => one.name === member.upstream);
    const isUnknown = upstream === undefined;
    const isUncached = upstream?.schema === null;
    if (isUnknown === false && isUncached === false) {
      return [];
    }
    const message = isUnknown
      ? `There is no upstream "${member.upstream}". Add it first, or name an upstream that exists.`
      : `"${member.upstream}" has no cached schema yet, so its documents can't be checked. Refresh its schema first.`;
    return [{ concept: concept.name, member: member.upstream, operation: null, message, line: null, column: null }];
  });
}

/**
 * Checks a parsed concept against the upstreams as they are now.
 *
 * @param concept - The concept.
 * @param upstreams - Every upstream.
 * @returns Every problem, empty when it can be served.
 */
function checkConcept(concept: Concept, upstreams: readonly Upstream[]): ConceptProblem[] {
  const missing = memberProblems(concept, upstreams);
  const flagged = new Set(missing.map((problem) => problem.member));
  // A member without a schema can only be reported missing again, so the validator's word on it is left out.
  const documentProblems = validateConcepts([concept], schemasByName(upstreams)).filter(
    (problem) => problem.member === null || flagged.has(problem.member) === false,
  );
  const problems = [...missing, ...documentProblems];
  // A priority is checked against the member's entity type, which needs documents that read.
  return problems.length > 0 ? problems : priorityProblems(concept, schemasByName(upstreams));
}

/**
 * Parses and checks a definition.
 *
 * @param definition - Stored or submitted JSON.
 * @param upstreams - Every upstream.
 * @returns The concept (null when it does not parse) and its problems.
 */
export function readDefinition(
  definition: unknown,
  upstreams: readonly Upstream[],
): { concept: Concept | null; problems: ConceptProblem[] } {
  const parsed = conceptSchema.safeParse(definition);
  if (parsed.success === false) {
    return { concept: null, problems: parseProblems(definition, parsed.error) };
  }
  return { concept: parsed.data, problems: checkConcept(parsed.data, upstreams) };
}

/**
 * Rewrites a stored definition's members for a renamed upstream. It works on the JSON as stored, which may no
 * longer parse, and touches nothing but the members that name the old upstream.
 *
 * @param definition - The definition as stored.
 * @param from - The upstream's old name.
 * @param to - Its new name.
 * @returns The rewritten definition, or null when no member names `from`.
 */
export function followUpstreamRename(definition: unknown, from: string, to: string): unknown {
  const hasMembers =
    typeof definition === 'object' &&
    definition !== null &&
    'members' in definition &&
    Array.isArray(definition.members);
  if (hasMembers === false) {
    return null;
  }
  let isChanged = false;
  const members = (definition.members as unknown[]).map((member) => {
    const isRenamed = typeof member === 'object' && member !== null && 'upstream' in member && member.upstream === from;
    if (isRenamed === false) {
      return member;
    }
    isChanged = true;
    // The member keeps the name it had, which was the old upstream name unless it already had its own.
    return { app: from, ...member, upstream: to };
  });
  return isChanged ? { ...definition, members } : null;
}

/**
 * Builds the concept service, and makes stored definitions follow renamed upstreams.
 *
 * @param deps - The database, the upstreams, and the feeds.
 * @returns The service.
 */
export function createConceptService(deps: ConceptServiceDeps): ConceptService {
  const { db } = deps;

  /**
   * Checks a stored concept as things are now.
   *
   * @param row - The stored row.
   * @param upstreams - Every upstream.
   * @returns The record.
   */
  const toRecord = (row: ConceptRow, upstreams: readonly Upstream[]): ConceptRecord => ({
    id: row.id,
    name: row.name,
    definition: row.definition,
    ...readDefinition(row.definition, upstreams),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  /**
   * Finds a row by id or name.
   *
   * @param idOrName - Either.
   * @returns The row, or undefined.
   */
  const findRow = async (idOrName: string): Promise<ConceptRow | undefined> => {
    const column = UUID_PATTERN.test(idOrName) ? concepts.id : concepts.name;
    const [row] = await db.select().from(concepts).where(eq(column, idOrName));
    return row;
  };

  deps.upstreamEvents?.subscribe(async (event) => {
    const isRename = event.change === UpstreamChange.Updated && event.name !== event.previousName;
    if (isRename === false) {
      return;
    }
    const rows = await db.select().from(concepts);
    for (const row of rows) {
      const definition = followUpstreamRename(row.definition, event.previousName, event.name);
      if (definition !== null) {
        await db.update(concepts).set({ definition, updatedAt: new Date() }).where(eq(concepts.id, row.id));
        console.log(`[concepts] ${row.name}: member upstream ${event.previousName} renamed to ${event.name}`);
      }
    }
  });

  return {
    list: async () => {
      const [rows, upstreams] = await Promise.all([
        db.select().from(concepts).orderBy(concepts.name),
        deps.upstreams.list(),
      ]);
      return rows.map((row) => toRecord(row, upstreams));
    },

    find: async (idOrName) => {
      const row = await findRow(idOrName);
      return row === undefined ? null : toRecord(row, await deps.upstreams.list());
    },

    save: async (definition) => {
      const upstreams = await deps.upstreams.list();
      const { concept, problems } = readDefinition(definition, upstreams);
      if (concept === null || problems.length > 0) {
        throw badInput(new ConceptValidationError(problems).message, { problems });
      }
      const values = { name: concept.name, definition };
      const [row] = await db
        .insert(concepts)
        .values(values)
        .onConflictDoUpdate({ target: concepts.name, set: { definition, updatedAt: new Date() } })
        .returning();
      if (row === undefined) {
        throw new Error('The concept upsert returned no row.');
      }
      console.log(`[concepts] ${concept.name}: saved`);
      await deps.changes?.emit({ reason: `concept ${concept.name} saved` });
      return toRecord(row, upstreams);
    },

    remove: async (idOrName) => {
      const row = await findRow(idOrName);
      if (row === undefined) {
        return false;
      }
      await db.delete(concepts).where(eq(concepts.id, row.id));
      console.log(`[concepts] ${row.name}: removed`);
      await deps.changes?.emit({ reason: `concept ${row.name} removed` });
      return true;
    },
  };
}
