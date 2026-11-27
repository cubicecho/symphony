// Reading a concept definition for display. The definition is JSON the user edits, so every reader here takes
// `unknown`, tolerates a half-typed draft, and ignores keys it does not know: those are kept in the JSON as typed.

/** The four documents a member holds, in the order the server reports problems. */
export const CONCEPT_OPERATIONS = ['fetch', 'create', 'update', 'delete'] as const;

/** One of a member's documents. */
export type ConceptOperation = (typeof CONCEPT_OPERATIONS)[number];

/** One located problem with a concept, as the server reports it. Lines and columns count from 1. */
export interface ConceptProblem {
  concept: string;
  /** The member's upstream; null for a problem with the concept as a whole. */
  member: string | null;
  /** Which document of the member; null when it is about the member, not one document. */
  operation: string | null;
  message: string;
  line: number | null;
  column: number | null;
}

/** A field of a concept, as far as a reader needs it. */
export interface SummaryField {
  name: string;
  /** The owning member's upstream, for an owned field; null for a shared one. */
  owner: string | null;
}

/** One member of a concept, and the documents it has. */
export interface SummaryMember {
  upstream: string;
  /** The member's documents, in operation order; a document left out is not listed. */
  documents: { operation: ConceptOperation; text: string }[];
  /** The fields this member owns. */
  owned: string[];
}

/** What a definition says, for a reader. */
export interface ConceptSummary {
  /** Null while the draft has no name. */
  name: string | null;
  shared: SummaryField[];
  owned: SummaryField[];
  members: SummaryMember[];
}

/** The outcome of reading the editor's text as JSON. */
export type DefinitionParse = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Narrows a value to a plain object.
 *
 * @param value - Anything.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

/**
 * Reads a string member of an object.
 *
 * @param value - Anything.
 * @param key - The member.
 * @returns The string, or null when it is missing or not a string.
 */
function stringAt(value: unknown, key: string): string | null {
  if (isRecord(value) === false) {
    return null;
  }
  const member = value[key];
  return typeof member === 'string' ? member : null;
}

/**
 * Reads an array member of an object.
 *
 * @param value - Anything.
 * @param key - The member.
 * @returns The array, or an empty one when it is missing or not an array.
 */
function arrayAt(value: unknown, key: string): unknown[] {
  if (isRecord(value) === false) {
    return [];
  }
  const member = value[key];
  return Array.isArray(member) ? member : [];
}

/**
 * Reads a concept's fields, skipping entries without a name.
 *
 * @param definition - The definition.
 * @returns Each named field with its owner, null for a shared one.
 */
function fieldsOf(definition: unknown): SummaryField[] {
  const fields: SummaryField[] = [];
  for (const field of arrayAt(definition, 'fields')) {
    const name = stringAt(field, 'name');
    if (name !== null) {
      const isOwned = stringAt(field, 'mode') === 'owned';
      fields.push({ name, owner: isOwned ? (stringAt(field, 'owner') ?? '') : null });
    }
  }
  return fields;
}

/**
 * Summarizes a concept definition: its shared and owned fields, and its members with their documents.
 *
 * @param definition - A definition as stored, or as parsed from a draft; any shape is accepted.
 * @returns What it says, leaving out whatever is missing or malformed.
 */
export function summarizeDefinition(definition: unknown): ConceptSummary {
  const fields = fieldsOf(definition);
  const owned = fields.filter((field) => field.owner !== null);
  const members: SummaryMember[] = [];
  for (const member of arrayAt(definition, 'members')) {
    const upstream = stringAt(member, 'upstream');
    if (upstream !== null) {
      const documents = isRecord(member) ? member.documents : undefined;
      members.push({
        upstream,
        documents: CONCEPT_OPERATIONS.flatMap((operation) => {
          const text = stringAt(documents, operation);
          return text === null ? [] : [{ operation, text }];
        }),
        owned: owned.filter((field) => field.owner === upstream).map((field) => field.name),
      });
    }
  }
  return {
    name: stringAt(definition, 'name'),
    shared: fields.filter((field) => field.owner === null),
    owned,
    members,
  };
}

/**
 * Reads the editor's text as JSON.
 *
 * @param text - What the user typed.
 * @returns The value, or the parser's message.
 */
export function parseDefinitionText(text: string): DefinitionParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Prints a definition for the editor.
 *
 * @param definition - Any JSON value.
 * @returns Indented JSON.
 */
export function formatDefinition(definition: unknown): string {
  return JSON.stringify(definition, null, 2);
}

/**
 * Narrows one entry of `extensions.problems` to a concept problem.
 *
 * @param value - One entry.
 * @returns The problem, or null when it has no message.
 */
function problemOf(value: unknown): ConceptProblem | null {
  const message = stringAt(value, 'message');
  if (message === null || isRecord(value) === false) {
    return null;
  }
  const numberAt = (key: string): number | null => {
    const member = value[key];
    return typeof member === 'number' ? member : null;
  };
  return {
    concept: stringAt(value, 'concept') ?? '',
    member: stringAt(value, 'member'),
    operation: stringAt(value, 'operation'),
    message,
    line: numberAt('line'),
    column: numberAt('column'),
  };
}

/**
 * Reads the located problems a refused saveConcept carries in its first error's `extensions.problems`.
 *
 * @param error - What the mutation threw.
 * @returns The problems, or null when the error carries none.
 */
export function conceptProblemsOf(error: unknown): ConceptProblem[] | null {
  const extensions = typeof error === 'object' && error !== null && 'extensions' in error ? error.extensions : null;
  const problems = isRecord(extensions) ? extensions.problems : undefined;
  if (Array.isArray(problems) === false) {
    return null;
  }
  return problems.map(problemOf).filter((problem) => problem !== null);
}

/**
 * Picks the problems about one place in a definition.
 *
 * @param problems - Every problem.
 * @param member - The member's upstream, or null for the concept as a whole.
 * @param operation - The document, or null for problems about the member that name no document.
 * @returns The problems placed there.
 */
export function problemsAt(
  problems: readonly ConceptProblem[],
  member: string | null,
  operation: string | null,
): ConceptProblem[] {
  return problems.filter((problem) => problem.member === member && problem.operation === operation);
}

/**
 * Names where a problem is.
 *
 * @param problem - The problem.
 * @returns "billing · fetch · 3:7", "billing", or null when it is about the concept as a whole.
 */
export function placeOf(problem: Pick<ConceptProblem, 'member' | 'operation' | 'line' | 'column'>): string | null {
  const parts: string[] = [];
  if (problem.member !== null) {
    parts.push(problem.member);
  }
  if (problem.operation !== null) {
    parts.push(problem.operation);
  }
  if (problem.line !== null) {
    parts.push(problem.column === null ? `line ${problem.line}` : `${problem.line}:${problem.column}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}
