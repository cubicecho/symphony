// Symphony's id for a concept entity: one UUID, the same value in every member upstream.
import { randomUUID } from 'node:crypto';
import { badInput } from '../core/errors.ts';

/** A UUID in its canonical text form, in either case: 8-4-4-4-12 hex digits. */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tells whether a value is a UUID in canonical text form, in either case.
 *
 * @param value - Anything.
 * @returns True for a string such as `3f2b8c1e-9d4a-4c6b-8e2f-1a7d5c9b0e44`.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_TEXT.test(value);
}

/**
 * Checks a caller's id and puts it in the one form every member stores: lower case.
 *
 * @param value - The id the caller sent.
 * @returns The id, lower-cased.
 * @throws BAD_USER_INPUT when it is not a UUID.
 */
export function normalizeUuid(value: string): string {
  const isValid = isUuid(value);
  if (isValid === false) {
    throw badInput(
      `"${value}" is not a UUID. A concept entity's id is a UUID such as 3f2b8c1e-9d4a-4c6b-8e2f-1a7d5c9b0e44; leave it out on create to have one minted.`,
    );
  }
  return value.toLowerCase();
}

/**
 * Mints the id of a new concept entity.
 *
 * @returns A random (version 4) UUID, lower-cased.
 */
export function mintUuid(): string {
  return randomUUID();
}
