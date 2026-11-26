import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';

/** The admin API. The browser talks to its own origin; Vite proxies `/graphql` to the server in dev. */
const ADMIN_ENDPOINT = '/graphql';

/** One entry of a response's `errors`. */
interface GraphQLErrorEntry {
  message: string;
  extensions?: { code?: string };
}

/** A GraphQL response body, as far as the app reads it. */
interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLErrorEntry[];
}

/** What one GraphQL request sends. */
export interface GraphQLOperation {
  /** The document's text. */
  query: string;
  /** Its variables; left out when it takes none. */
  variables?: Record<string, unknown> | undefined;
  /** Which operation in the document to run, when it names one. */
  operationName?: string | null | undefined;
}

/** A request the server answered with errors. `code` is the first error's `extensions.code`, when it has one. */
export class RequestError extends Error {
  readonly code: string | undefined;

  /**
   * Joins the messages of a GraphQL error list into one error.
   *
   * @param errors - The `errors` member of a response.
   */
  constructor(errors: GraphQLErrorEntry[]) {
    super(errors.map((error) => error.message).join('; '));
    this.name = 'RequestError';
    this.code = errors[0]?.extensions?.code;
  }
}

/**
 * Reads a response body as GraphQL JSON, or explains why it is not.
 *
 * @param response - The fetch response.
 * @returns The parsed body.
 * @throws An `Error` naming the HTTP status when the body is not JSON.
 */
async function readBody<T>(response: Response): Promise<GraphQLResponse<T>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as GraphQLResponse<T>;
  } catch {
    throw new Error(`The server answered HTTP ${response.status} with something that is not GraphQL JSON.`);
  }
}

/**
 * Posts one GraphQL operation to an endpoint: the admin API or an upstream's proxy path.
 *
 * @typeParam T - What `data` holds.
 * @param endpoint - Where to post, on this origin.
 * @param operation - The document, its variables and its operation name.
 * @returns The response's `data`.
 * @throws A `RequestError` when the response carries errors, an `Error` when it carries no data.
 */
export async function postGraphQL<T>(endpoint: string, operation: GraphQLOperation): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(operation),
  });
  const body = await readBody<T>(response);
  // GraphQL reports failures in the body, often with a 200, so the status alone proves nothing.
  const hasErrors = body.errors !== undefined && body.errors.length > 0;
  if (hasErrors) {
    throw new RequestError(body.errors ?? []);
  }
  if (body.data === undefined || body.data === null) {
    throw new Error(`The server sent no data (HTTP ${response.status}).`);
  }
  return body.data;
}

/**
 * Sends one admin API request, typed by its document.
 *
 * @param document - The typed query or mutation.
 * @param variables - Its variables, left out when it takes none.
 * @returns The response's `data`.
 */
export async function request<TResult, TVariables>(
  document: TypedDocumentNode<TResult, TVariables>,
  ...[variables]: TVariables extends Record<string, never> ? [] : [TVariables]
): Promise<TResult> {
  return postGraphQL<TResult>(ADMIN_ENDPOINT, {
    query: print(document),
    variables: variables as Record<string, unknown> | undefined,
  });
}

/**
 * Fetches a text file from this origin: a compiled module's code.
 *
 * @param url - Where it is.
 * @returns The body.
 * @throws An `Error` naming the URL and the status when the server does not answer 2xx.
 */
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (response.ok === false) {
    throw new Error(`Couldn't load ${url} (HTTP ${response.status}).`);
  }
  return response.text();
}
