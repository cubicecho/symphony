import { GraphQLError } from 'graphql';

/** The `extensions.code` values clients branch on. */
export const ErrorCode = {
  NotFound: 'NOT_FOUND',
  BadUserInput: 'BAD_USER_INPUT',
  QueryTooComplex: 'QUERY_TOO_COMPLEX',
  /** The request contradicts the instance's state: a name already in use. */
  Conflict: 'CONFLICT',
  /** An upstream API could not be reached, refused the request, or answered with something that is not GraphQL. */
  UpstreamFailed: 'UPSTREAM_FAILED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Makes an error factory for one code.
 *
 * @param code - The `extensions.code` value.
 * @returns A function from message, and any details a client reads beside the code, to GraphQLError.
 */
const withCode =
  (code: ErrorCode) =>
  (message: string, details: Readonly<Record<string, unknown>> = {}): GraphQLError =>
    new GraphQLError(message, { extensions: { ...details, code } });

/** Arguments the caller can fix. */
export const badInput = withCode(ErrorCode.BadUserInput);
/** No such thing. */
export const notFound = withCode(ErrorCode.NotFound);
/** The operation is too deep, too aliased or too costly. */
export const tooComplex = withCode(ErrorCode.QueryTooComplex);
/** The instance is not in a state this can be done in. */
export const conflict = withCode(ErrorCode.Conflict);
/** An upstream failed. */
export const upstreamFailed = withCode(ErrorCode.UpstreamFailed);

/**
 * Reads the message of any caught value.
 *
 * @param error - Whatever was thrown.
 * @returns `error.message` for an Error, otherwise `String(error)`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
