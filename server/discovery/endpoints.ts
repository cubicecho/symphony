// What Symphony advertises: a Server Card for /mcp, listed in the AI Catalog that discoveryMiddleware serves.
import { hostname } from 'node:os';
import {
  type AdvertisedEndpoint,
  airIdentifier,
  createServerCard,
  hostSlug,
  type KeyValueInput,
  TRANSPORT_STREAMABLE_HTTP,
} from '@cubicecho/mcp-discovery';
import { MCP_ENDPOINT } from '../mcp/endpoint.ts';

/** The reverse-DNS namespace every card's name starts with; the host's slug is appended to it. */
const CARD_NAMESPACE = 'io.github.cubicecho.symphony';

/** What follows the host's slug in the catalog entry's `urn:air` publisher. */
const AIR_PUBLISHER = 'symphony';

/** The endpoint's stable name under the host, the last part of its card name and `urn:air` id. */
const ENDPOINT_NAME = 'modules';

/** The project's source, shown on the card. */
const REPOSITORY = { url: 'https://github.com/cubicecho/symphony', source: 'github' } as const;

/** The card's description; a Server Card allows 100 characters. */
const DESCRIPTION = 'Runtime web UIs over GraphQL APIs: write React modules against cached upstream schemas.';

/** The header a client must send, since /mcp always asks for the key; its value is never in the card. */
const AUTH_HEADER: KeyValueInput = {
  name: 'Authorization',
  description: 'Bearer <SYMPHONY_MCP_KEY>; the same key in x-api-key works too',
  isRequired: true,
  isSecret: true,
};

/** What the endpoints are built from. */
export interface DiscoveryEndpointOptions {
  /** Symphony's version, shown on the card. */
  version: string;
  /**
   * The machine's hostname, which keeps card names apart when two servers share a network.
   *
   * @defaultValue `os.hostname()`
   */
  host?: string;
}

/**
 * Lists the MCP endpoints Symphony makes discoverable: `/mcp`, the only one.
 *
 * @param options - The version, and optionally the hostname.
 * @returns The endpoint, with a card builder that names the URL the request came in on.
 */
export function discoveryEndpoints(options: DiscoveryEndpointOptions): AdvertisedEndpoint[] {
  const { version, host = hostname() } = options;
  const slug = hostSlug(host);
  return [
    {
      path: MCP_ENDPOINT,
      identifier: airIdentifier(`${slug}.${AIR_PUBLISHER}`, ENDPOINT_NAME),
      card: ({ endpointUrl }) =>
        createServerCard({
          name: `${CARD_NAMESPACE}.${slug}/${ENDPOINT_NAME}`,
          version,
          title: `Symphony on ${host}`,
          description: DESCRIPTION,
          repository: REPOSITORY,
          remotes: [{ type: TRANSPORT_STREAMABLE_HTTP, url: endpointUrl, headers: [AUTH_HEADER] }],
        }),
    },
  ];
}
