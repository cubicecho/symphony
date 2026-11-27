// Concept proposals: drafts the proposer makes from the upstreams' schemas, and definitions agents and people
// submit. A submit is checked like a concept save but stored whatever it finds, so the submitter can revise it by
// id until it passes; accepting is a person's step, and saves it through the concept service.
import { desc, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { proposeConcepts } from '../concepts/propose.ts';
import type { ConceptProblem } from '../concepts/validate.ts';
import { UUID_PATTERN } from '../core/consts.ts';
import { badInput, conflict, notFound } from '../core/errors.ts';
import {
  type ConceptProposalRecord,
  type ConceptProposalService,
  type ConceptRecord,
  type ConceptService,
  ProposalSource,
  ProposalStatus,
  type Upstream,
  type UpstreamService,
} from '../core/services.ts';
import type { Database } from '../db/client.ts';
import { conceptProposals } from '../db/schema.ts';
import { nameOf, readDefinition, schemasByName } from './concept-service.ts';

/** What the service talks to. */
export interface ProposalServiceDeps {
  db: Database;
  /** Where the proposer reads the cached schemas, and submits are checked against. */
  upstreams: UpstreamService;
  /** What accepting saves through. */
  concepts: ConceptService;
}

type ProposalRow = typeof conceptProposals.$inferSelect;

const STATUSES = new Set<string>(Object.values(ProposalStatus));
const SOURCES = new Set<string>(Object.values(ProposalSource));

/**
 * Reads a stored row as a record.
 *
 * @param row - The row.
 * @returns The record.
 * @throws When the row's status or source is not one the table allows.
 */
function toRecord(row: ProposalRow): ConceptProposalRecord {
  const { status, source } = row;
  if (STATUSES.has(status) === false || SOURCES.has(source) === false) {
    throw new Error(`Concept proposal ${row.id} has status "${status}" and source "${source}".`);
  }
  return {
    id: row.id,
    name: row.name,
    definition: row.definition,
    status: status as ProposalStatus,
    source: source as ProposalSource,
    problems: row.problems,
    note: row.note,
    reason: row.reason,
    conceptId: row.conceptId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Picks the upstreams to propose from.
 *
 * @param all - Every upstream.
 * @param names - The names asked for, or undefined for every upstream with a cached schema.
 * @returns The upstreams.
 * @throws NOT_FOUND for a name that is no upstream, BAD_USER_INPUT for one with no cached schema.
 */
function pickUpstreams(all: readonly Upstream[], names: readonly string[] | undefined): Upstream[] {
  if (names === undefined) {
    return all.filter((upstream) => upstream.schema !== null);
  }
  return names.map((name) => {
    const upstream = all.find((one) => one.name === name);
    if (upstream === undefined) {
      throw notFound(`There is no upstream "${name}".`);
    }
    if (upstream.schema === null) {
      throw badInput(`"${name}" has no cached schema yet, so nothing can be proposed from it. Refresh it first.`);
    }
    return upstream;
  });
}

/**
 * Builds the proposal service.
 *
 * @param deps - The database, the upstreams and the concepts.
 * @returns The service.
 */
export function createProposalService(deps: ProposalServiceDeps): ConceptProposalService {
  const { db } = deps;

  /**
   * Finds a proposal's row.
   *
   * @param id - Its id.
   * @returns The row, or undefined; a value that is no UUID finds nothing.
   */
  const findRow = async (id: string): Promise<ProposalRow | undefined> => {
    if (UUID_PATTERN.test(id) === false) {
      return undefined;
    }
    const [row] = await db.select().from(conceptProposals).where(eq(conceptProposals.id, id));
    return row;
  };

  /**
   * Finds a proposal a person may still decide on, or one a submit may revise.
   *
   * @param id - Its id.
   * @param doing - What the caller wants to do, for the refusal.
   * @returns The row.
   * @throws NOT_FOUND, or CONFLICT when it is no longer pending.
   */
  const requirePending = async (id: string, doing: string): Promise<ProposalRow> => {
    const row = await findRow(id);
    if (row === undefined) {
      throw notFound(`There is no concept proposal ${id}.`);
    }
    if (row.status !== ProposalStatus.Pending) {
      throw conflict(`Concept proposal ${id} is ${row.status}, so it can't be ${doing}. Submit a new one instead.`);
    }
    return row;
  };

  /**
   * Updates one proposal's row.
   *
   * @param id - Its id.
   * @param values - The columns to set.
   * @returns The record after the update.
   */
  const updateRow = async (
    id: string,
    values: Partial<typeof conceptProposals.$inferInsert>,
  ): Promise<ConceptProposalRecord> => {
    const [row] = await db
      .update(conceptProposals)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(conceptProposals.id, id))
      .returning();
    if (row === undefined) {
      throw new Error(`The concept proposal ${id} update returned no row.`);
    }
    return toRecord(row);
  };

  return {
    propose: async (names) => {
      const upstreams = pickUpstreams(await deps.upstreams.list(), names);
      const found = proposeConcepts(schemasByName(upstreams));
      return {
        drafts: found.drafts.map((draft) => ({
          ...draft,
          problems: readDefinition(draft.definition, upstreams).problems,
        })),
        notReady: found.notReady,
      };
    },

    list: async (status) => {
      const rows = await db
        .select()
        .from(conceptProposals)
        .where(status === undefined ? undefined : eq(conceptProposals.status, status))
        .orderBy(desc(conceptProposals.createdAt));
      return rows.map(toRecord);
    },

    find: async (id) => {
      const row = await findRow(id);
      return row === undefined ? null : toRecord(row);
    },

    submit: async (input) => {
      const { problems } = readDefinition(input.definition, await deps.upstreams.list());
      const values = {
        name: nameOf(input.definition),
        definition: input.definition,
        problems,
        source: input.source,
        note: input.note ?? null,
      };
      if (input.id !== undefined) {
        await requirePending(input.id, 'revised');
        return updateRow(input.id, values);
      }
      const [row] = await db.insert(conceptProposals).values(values).returning();
      if (row === undefined) {
        throw new Error('The concept proposal insert returned no row.');
      }
      console.log(`[proposals] ${row.name || row.id}: submitted by ${row.source}`);
      return toRecord(row);
    },

    accept: async (id) => {
      const row = await requirePending(id, 'accepted');
      let concept: ConceptRecord;
      try {
        concept = await deps.concepts.save(row.definition);
      } catch (error) {
        // An upstream may have changed since the submit: keep what the refusal found, so the proposal shows it.
        const refused = error instanceof GraphQLError ? error.extensions.problems : undefined;
        if (Array.isArray(refused)) {
          await updateRow(id, { problems: refused as ConceptProblem[] });
        }
        throw error;
      }
      console.log(`[proposals] ${row.name}: accepted as concept ${concept.id}`);
      return updateRow(id, { status: ProposalStatus.Accepted, conceptId: concept.id, problems: [] });
    },

    reject: async (id, reason) => {
      await requirePending(id, 'rejected');
      console.log(`[proposals] ${id}: rejected`);
      return updateRow(id, { status: ProposalStatus.Rejected, reason: reason ?? null });
    },
  };
}
