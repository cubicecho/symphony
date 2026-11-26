// How a tool answers: text cut to the MCP budget, and failures as error results an agent can read.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';

/** Most close names a "did you mean" offers. */
const MAX_SUGGESTIONS = 5;

/** Typos a short name may have and still be suggested. */
const MIN_TYPOS = 2;

/** A longer name may have one typo per this many characters: a third of a word wrong still reads as it. */
const CHARS_PER_TYPO = 3;

/** Spaces JSON answers are indented with: readable for an agent, and cheap. */
const JSON_INDENT = 2;

/**
 * Cuts a text to the answer budget, saying how much was left out and how to ask for less.
 *
 * @param text - The full answer.
 * @param narrow - What the caller can do to get a smaller answer, as an instruction.
 * @param [maxChars] - The budget, in characters.
 * @returns The text, or its start and a note when it is over the budget.
 */
export function fitAnswer(text: string, narrow: string, maxChars: number = MCP_DEFAULTS.maxAnswerChars): string {
  if (text.length <= maxChars) {
    return text;
  }
  const note = `\n\n[Cut at ${maxChars} of ${text.length} characters. ${narrow}]`;
  return `${text.slice(0, Math.max(0, maxChars - note.length))}${note}`;
}

/**
 * Makes a text result.
 *
 * @param text - The answer.
 * @param narrow - How to ask for less, should it be cut.
 * @returns The tool result.
 */
export function textResult(text: string, narrow: string): CallToolResult {
  return { content: [{ type: 'text', text: fitAnswer(text, narrow) }] };
}

/**
 * Makes a result from a value, as indented JSON.
 *
 * @param value - Anything JSON can hold.
 * @param narrow - How to ask for less, should it be cut.
 * @returns The tool result.
 */
export function jsonResult(value: unknown, narrow: string): CallToolResult {
  return textResult(JSON.stringify(value, null, JSON_INDENT), narrow);
}

/**
 * Makes an error result from anything thrown.
 *
 * @param error - The caught value; a GraphQLError's message is written for the caller already.
 * @returns The tool result, marked as an error.
 */
export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: fitAnswer(errorMessage(error), '') }], isError: true };
}

/**
 * Counts the single-character edits between two strings.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns The Levenshtein distance.
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (const [i, charA] of [...a].entries()) {
    const current = [i + 1];
    for (const [j, charB] of [...b].entries()) {
      const substitution = (previous[j] ?? 0) + (charA === charB ? 0 : 1);
      current.push(Math.min((previous[j + 1] ?? 0) + 1, (current[j] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Picks the names closest to one that matched nothing.
 *
 * @param wanted - What the caller asked for.
 * @param names - Every name that exists.
 * @returns Up to a handful of names, closest first: those containing it (or contained by it), then near spellings.
 */
export function closeNames(wanted: string, names: readonly string[]): string[] {
  const lower = wanted.toLowerCase();
  const maxDistance = Math.max(MIN_TYPOS, Math.floor(lower.length / CHARS_PER_TYPO));
  const scored = [...new Set(names)].map((name) => {
    const candidate = name.toLowerCase();
    const overlaps = lower !== '' && (candidate.includes(lower) || lower.includes(candidate));
    return { name, score: overlaps ? 0 : editDistance(lower, candidate) };
  });
  return scored
    .filter((one) => one.score <= maxDistance)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((one) => one.name);
}

/**
 * Writes a "did you mean" clause.
 *
 * @param wanted - What the caller asked for.
 * @param names - Every name that exists.
 * @returns ` Did you mean A, B?`, or an empty string when nothing is close.
 */
export function didYouMean(wanted: string, names: readonly string[]): string {
  const close = closeNames(wanted, names);
  return close.length === 0 ? '' : ` Did you mean ${close.join(', ')}?`;
}
