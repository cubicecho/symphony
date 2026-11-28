// The /mcp endpoint: Streamable HTTP, stateless (a fresh server and transport per POST), behind a key.
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, RequestHandler, Response } from 'express';
import { errorMessage } from '../core/errors.ts';
import type { Services } from '../core/services.ts';
import { HttpStatus } from '../core/wire.ts';
import { createSymphonyMcpServer } from './server.ts';
import { LOG_TAG } from './tool-kit.ts';

/** Where the endpoint is mounted. */
export const MCP_ENDPOINT = '/mcp';

/** What an Authorization header's value starts with. */
const BEARER_PREFIX = 'Bearer ';

/** Statuses this endpoint sends that wire.ts does not list. */
const McpHttpStatus = { MethodNotAllowed: 405, ServerError: 500 } as const;

/** JSON-RPC's code for an error inside the server. */
const JSON_RPC_INTERNAL_ERROR = -32603;

/** The one method a stateless endpoint answers. */
const POST = 'POST';

/** What the MCP handler is built with. */
export interface McpHandlerOptions {
  /** The key every caller sends. Empty refuses every call. */
  key: string;
  /** Symphony's version, for the handshake. */
  version: string;
}

/**
 * Compares two keys in constant time.
 *
 * @param given - The key a caller sent.
 * @param expected - The server's key.
 * @returns True when they match.
 */
function keysMatch(given: string, expected: string): boolean {
  const digest = (key: string) => createHash('sha256').update(key).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Reads the key a request carries, from `x-api-key` or as a Bearer token.
 *
 * @param request - The request.
 * @returns The key, or an empty string when it carries none.
 */
function keyOf(request: Request): string {
  const apiKey = request.get('x-api-key')?.trim() ?? '';
  if (apiKey !== '') {
    return apiKey;
  }
  const authorization = request.get('authorization') ?? '';
  return authorization.startsWith(BEARER_PREFIX) ? authorization.slice(BEARER_PREFIX.length).trim() : '';
}

/**
 * Says why a request is refused, if it is.
 *
 * @param request - The request.
 * @param key - The server's key.
 * @returns The refusal message, or null when the key matches.
 */
function refusal(request: Request, key: string): string | null {
  if (key === '') {
    return 'SYMPHONY_MCP_KEY is not set on the Symphony server, so /mcp refuses every call. Set it and restart.';
  }
  const given = keyOf(request);
  if (given === '') {
    return 'Send the Symphony MCP key in the x-api-key header (or as Authorization: Bearer <key>).';
  }
  return keysMatch(given, key) ? null : 'The MCP key is wrong.';
}

/**
 * Runs one MCP request on a fresh server and transport.
 *
 * @param services - The shared services.
 * @param version - Symphony's version.
 * @param request - The POST, its JSON body already parsed.
 * @param response - Where the answer goes.
 */
async function handlePost(services: Services, version: string, request: Request, response: Response): Promise<void> {
  const server = createSymphonyMcpServer(services, version);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error(LOG_TAG, `request failed: ${errorMessage(error)}`);
    if (response.headersSent === false) {
      response.status(McpHttpStatus.ServerError).json({
        jsonrpc: '2.0',
        error: { code: JSON_RPC_INTERNAL_ERROR, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

/**
 * Builds the /mcp handler. Mount it with `app.all`, behind `express.json`.
 *
 * @param services - The services /graphql uses too.
 * @param options - The key and the version.
 * @returns The Express handler.
 */
export function createMcpHandler(services: Services, options: McpHandlerOptions): RequestHandler {
  const { key, version } = options;
  return async (request, response) => {
    const refused = refusal(request, key);
    if (refused !== null) {
      console.warn(LOG_TAG, `refused a ${request.method} from ${request.ip ?? 'unknown'}: ${refused}`);
      response.status(HttpStatus.Unauthorized).json({ error: refused });
      return;
    }
    const isPost = request.method === POST;
    if (isPost === false) {
      response
        .status(McpHttpStatus.MethodNotAllowed)
        .set('Allow', POST)
        .json({ error: 'This MCP endpoint is stateless: send every message as a POST.' });
      return;
    }
    await handlePost(services, version, request, response);
  };
}
