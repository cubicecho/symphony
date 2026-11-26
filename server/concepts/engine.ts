// The one engine behind every concept's resolvers: it reads a concept row and runs each member's stored
// documents through an injected `execute`, so it plugs into UpstreamService.execute without the database.
//
// Writes go to each member at once and never roll back: a member that fails is reported, and `partial` says
// some did. A delete counts as done for a member when it answers without errors, or, when it fails, when that
// member's fetch then finds nothing for the key: the entity is gone either way, whatever the upstream calls
// "not found" (a null payload, an error, a code), so deleting twice is not an error.
import { badInput, errorMessage, notFound } from '../core/errors.ts';
import type { GraphQLRequest, GraphQLResponseBody } from '../core/services.ts';
import {
  type Concept,
  type ConceptMember,
  ConceptOperation,
  FieldMode,
  fieldsOwnedBy,
  keyFieldOf,
  PRESENCE_FIELD,
} from './concept.ts';
import {
  boundField,
  isRequiredVariable,
  type MemberDocument,
  type MemberDocuments,
  memberDocuments,
} from './validate.ts';

/** Sends one request to an upstream by name. UpstreamService.execute has this shape. */
export type ExecuteUpstream = (upstream: string, request: GraphQLRequest) => Promise<GraphQLResponseBody>;

/** How one member holds an entity, as the `PresenceStatus` enum names it. */
export const PresenceStatus = {
  Present: 'PRESENT',
  Missing: 'MISSING',
  Drifted: 'DRIFTED',
  Error: 'ERROR',
} as const;
export type PresenceStatus = (typeof PresenceStatus)[keyof typeof PresenceStatus];

/** Field values by concept field name. */
export type FieldValues = Readonly<Record<string, unknown>>;

/** A shared field whose value differs from the first member that has the entity. */
export interface FieldDrift {
  field: string;
  expected: unknown;
  actual: unknown;
}

/** How one member holds an entity. */
export interface Presence {
  /** The member's upstream name. */
  app: string;
  status: PresenceStatus;
  drift: FieldDrift[];
  error: string | null;
  /** What the member's fetch returned, or null. */
  data: unknown;
}

/** A concept read from every member: the key, the shared fields of the first member that has it, and presence. */
export type ConceptView = Record<string, unknown> & { [PRESENCE_FIELD]: Presence[] };

/** What one member did with a write. */
export interface AppWriteResult {
  /** The member's upstream name. */
  app: string;
  ok: boolean;
  error: string | null;
}

/** What a write did across members. */
export interface WriteResult {
  key: unknown;
  results: AppWriteResult[];
  /** True when any member failed. */
  partial: boolean;
}

/** What a create takes. */
export interface CreateInput {
  /** The key and the shared fields. */
  shared: FieldValues;
  /** Each member's own fields, by upstream name. */
  own: Readonly<Record<string, FieldValues>>;
  /** The upstream names to create it in. */
  in: readonly string[];
}

/** What an update takes. Fields left out are kept; a null clears. */
export interface UpdateInput {
  key: unknown;
  shared: FieldValues;
  own: Readonly<Record<string, FieldValues>>;
}

/** What an attach takes. */
export interface AttachInput {
  key: unknown;
  /** The upstream name to create it in. */
  app: string;
  own: FieldValues;
}

/** The operations behind one concept's query and mutations. */
export interface ConceptEngine {
  /** @returns The concept, or null when no member has it and none failed to say. */
  read(key: unknown): Promise<ConceptView | null>;
  create(input: CreateInput): Promise<WriteResult>;
  /** @throws BAD_USER_INPUT when the patch changes nothing. */
  update(input: UpdateInput): Promise<WriteResult>;
  /** @throws NOT_FOUND when no other member has the entity to copy shared fields from. */
  attach(input: AttachInput): Promise<WriteResult>;
  remove(key: unknown): Promise<WriteResult>;
}

/** One member, with its documents parsed once. */
interface EngineMember {
  member: ConceptMember;
  documents: MemberDocuments;
}

/** What one document run gave back. */
interface DocumentOutcome {
  /** True when the upstream answered without errors. */
  answered: boolean;
  /** The root field's value, or null. */
  root: unknown;
  error: string | null;
}

/** What one member's fetch found. */
interface FetchOutcome {
  status: PresenceStatus;
  data: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Tells whether a value is a plain object, as a GraphQL response holds them.
 *
 * @param value - Anything.
 * @returns True for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

/**
 * Compares two field values as JSON.
 *
 * @param a - One value.
 * @param b - The other.
 * @returns True when they serialize the same, with undefined read as null.
 */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Builds a write result from each member's outcome.
 *
 * @param key - The entity's key.
 * @param results - One per member written.
 * @returns The result, partial when any failed.
 */
function writeResult(key: unknown, results: AppWriteResult[]): WriteResult {
  return { key, results, partial: results.some((result) => result.ok === false) };
}

/**
 * Builds the engine for one concept.
 *
 * @param concept - A concept that passed validateConcepts.
 * @param execute - Sends a request to an upstream by name.
 * @returns The engine.
 */
export function createConceptEngine(concept: Concept, execute: ExecuteUpstream): ConceptEngine {
  const key = keyFieldOf(concept);
  const shared = concept.fields.filter((field) => field.mode === FieldMode.Shared);
  const members: EngineMember[] = concept.members.map((member) => ({ member, documents: memberDocuments(member) }));

  const memberNamed = (upstream: string): EngineMember => {
    const found = members.find((one) => one.member.upstream === upstream);
    if (found === undefined) {
      throw badInput(`${upstream} is not a member of ${concept.name}.`);
    }
    return found;
  };

  /**
   * Runs one member document with the values its variables bind.
   *
   * @param one - The member.
   * @param operation - Which document.
   * @param values - Field values by field name; undefined ones are left out of the request.
   * @returns What the upstream answered.
   */
  const run = async (one: EngineMember, operation: ConceptOperation, values: FieldValues): Promise<DocumentOutcome> => {
    const parsed: MemberDocument = one.documents[operation];
    const variables: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const definition of parsed.operation.variableDefinitions ?? []) {
      const name = definition.variable.name.value;
      const field = boundField(concept, name);
      const value = field === undefined ? undefined : values[field.name];
      if (value !== undefined) {
        variables[name] = value;
      } else if (isRequiredVariable(definition)) {
        missing.push(`$${name}`);
      }
    }
    if (missing.length > 0) {
      return { answered: false, root: null, error: `${operation} needs ${missing.join(', ')}.` };
    }
    const request = {
      query: one.member.documents[operation],
      variables,
      operationName: parsed.operation.name?.value ?? null,
    };
    try {
      const body = await execute(one.member.upstream, request);
      const errors = body.errors ?? [];
      const root = isRecord(body.data) ? (Object.values(body.data)[0] ?? null) : null;
      if (errors.length > 0) {
        return { answered: false, root, error: errors.map((error) => error.message).join('; ') };
      }
      return { answered: true, root, error: null };
    } catch (error) {
      return { answered: false, root: null, error: errorMessage(error) };
    }
  };

  /**
   * Writes with a create or update document, which succeeds when it answers with a payload.
   *
   * @param one - The member.
   * @param operation - Create or update.
   * @param values - The values to bind.
   * @returns The member's write result.
   */
  const write = async (
    one: EngineMember,
    operation: ConceptOperation,
    values: FieldValues,
  ): Promise<AppWriteResult> => {
    const outcome = await run(one, operation, values);
    const app = one.member.upstream;
    if (outcome.answered && outcome.root === null) {
      return { app, ok: false, error: `${operation} returned null.` };
    }
    return { app, ok: outcome.answered, error: outcome.error };
  };

  const fetchFrom = async (one: EngineMember, keyValue: unknown): Promise<FetchOutcome> => {
    const outcome = await run(one, ConceptOperation.Fetch, { [key.name]: keyValue });
    if (outcome.answered === false) {
      return { status: PresenceStatus.Error, data: null, error: outcome.error };
    }
    if (isRecord(outcome.root)) {
      return { status: PresenceStatus.Present, data: outcome.root, error: null };
    }
    return { status: PresenceStatus.Missing, data: null, error: null };
  };

  const read = async (keyValue: unknown): Promise<ConceptView | null> => {
    const fetched = await Promise.all(
      members.map(async (one) => ({ app: one.member.upstream, outcome: await fetchFrom(one, keyValue) })),
    );
    const reference = fetched.find(({ outcome }) => outcome.status === PresenceStatus.Present)?.outcome.data ?? null;
    const presence: Presence[] = fetched.map(({ app, outcome }) => {
      const data = outcome.data;
      if (data === null || reference === null) {
        return { app, status: outcome.status, drift: [], error: outcome.error, data };
      }
      const drift = shared
        .filter((field) => sameValue(data[field.name], reference[field.name]) === false)
        .map((field) => ({
          field: field.name,
          expected: reference[field.name] ?? null,
          actual: data[field.name] ?? null,
        }));
      const status = drift.length > 0 ? PresenceStatus.Drifted : PresenceStatus.Present;
      return { app, status, drift, error: null, data };
    });
    const isUnknown = presence.every((one) => one.status === PresenceStatus.Missing);
    if (isUnknown) {
      return null;
    }
    const sharedValues = Object.fromEntries(shared.map((field) => [field.name, reference?.[field.name] ?? null]));
    return { [key.name]: keyValue, ...sharedValues, [PRESENCE_FIELD]: presence };
  };

  const create = async (input: CreateInput): Promise<WriteResult> => {
    const keyValue = input.shared[key.name];
    const chosen = [...new Set(input.in)].map(memberNamed);
    const results = await Promise.all(
      chosen.map((one) =>
        write(one, ConceptOperation.Create, { ...input.shared, ...(input.own[one.member.upstream] ?? {}) }),
      ),
    );
    return writeResult(keyValue, results);
  };

  const update = async (input: UpdateInput): Promise<WriteResult> => {
    const changes = members.flatMap((one) => {
      const values = { ...input.shared, ...(input.own[one.member.upstream] ?? {}) };
      const definitions = one.documents.update.operation.variableDefinitions ?? [];
      const touches = definitions.some((definition) => {
        const field = boundField(concept, definition.variable.name.value);
        return field !== undefined && field !== key && values[field.name] !== undefined;
      });
      return touches ? [{ one, values: { ...values, [key.name]: input.key } }] : [];
    });
    if (changes.length === 0) {
      throw badInput(`The update names no field to change on any ${concept.name} member.`);
    }
    const results = await Promise.all(changes.map(({ one, values }) => write(one, ConceptOperation.Update, values)));
    return writeResult(input.key, results);
  };

  const attach = async (input: AttachInput): Promise<WriteResult> => {
    const target = memberNamed(input.app);
    const owned = new Set(fieldsOwnedBy(concept, input.app).map((field) => field.name));
    const foreign = Object.keys(input.own).filter((name) => owned.has(name) === false);
    if (foreign.length > 0) {
      throw badInput(
        `${input.app} owns no field called ${foreign.join(', ')}. Its own fields: ${[...owned].join(', ')}.`,
      );
    }
    const others = members.filter((one) => one !== target);
    const fetched = await Promise.all(others.map((one) => fetchFrom(one, input.key)));
    const source = fetched.find((outcome) => outcome.status === PresenceStatus.Present)?.data ?? null;
    if (source === null) {
      throw notFound(`No other upstream has the ${concept.name} "${String(input.key)}" to copy shared fields from.`);
    }
    const sharedValues = Object.fromEntries(shared.map((field) => [field.name, source[field.name] ?? null]));
    const result = await write(target, ConceptOperation.Create, {
      ...sharedValues,
      ...input.own,
      [key.name]: input.key,
    });
    return writeResult(input.key, [result]);
  };

  const removeFrom = async (one: EngineMember, keyValue: unknown): Promise<AppWriteResult> => {
    const app = one.member.upstream;
    const outcome = await run(one, ConceptOperation.Delete, { [key.name]: keyValue });
    if (outcome.answered) {
      return { app, ok: true, error: null };
    }
    const after = await fetchFrom(one, keyValue);
    const isGone = after.status === PresenceStatus.Missing;
    return isGone ? { app, ok: true, error: null } : { app, ok: false, error: outcome.error };
  };

  const remove = async (keyValue: unknown): Promise<WriteResult> => {
    const results = await Promise.all(members.map((one) => removeFrom(one, keyValue)));
    return writeResult(keyValue, results);
  };

  return { read, create, update, attach, remove };
}
