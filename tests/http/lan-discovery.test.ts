import type { AddressInfo } from 'node:net';
import type { GraphqlServiceWatchHandlers } from '@cubicecho/graphql-mdns-discovery/mdns';
import { sql } from 'drizzle-orm';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { createLanUpstreamService } from '../../server/discovery/lan-upstreams.ts';
import { createApp } from '../../server/http/app.ts';
import { createUpstreamService } from '../../server/upstreams/upstream-service.ts';
import { openTestDatabase } from '../db.ts';
import { FIXTURE_URL, fixtureFetch } from '../fixtures/upstream.ts';

const KEY = 'Shop on nas/io.github.cubicecho.shop.nas/api';

let opened: OpenedDatabase;
let base = '';
let close: () => void = () => {};
let network: GraphqlServiceWatchHandlers = { onUp: () => undefined };

/**
 * Calls the admin API.
 *
 * @param query - The document.
 * @param variables - Its variables.
 * @returns The response body.
 */
async function admin(query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

beforeAll(async () => {
  opened = await openTestDatabase();
  const upstreams = createUpstreamService({ db: opened.db, fetch: fixtureFetch() });
  const lanUpstreams = createLanUpstreamService({
    upstreams,
    isWanted: () => true,
    startWatch: async (handlers) => {
      network = handlers;
      return { stop: async () => undefined };
    },
    log: () => undefined,
  });
  const { app } = createApp({
    db: opened.db,
    mcpKey: 'test-key',
    checkDatabase: () => opened.db.execute(sql`select 1`),
    fetch: fixtureFetch(),
    upstreams,
    lanUpstreams,
  });
  await lanUpstreams.start();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(async () => {
  close();
  await opened.close();
});

describe('LAN discovery over the admin API', () => {
  it('lists a found API, adds it, and shows it linked to the new upstream', async () => {
    network.onUp({
      key: KEY,
      host: {
        name: 'Shop on nas',
        host: 'nas.local',
        port: 80,
        addresses: [],
        txt: { path: '/graphql', documentPath: '/.well-known/graphql-services.json', tls: false },
        origin: 'http://nas.local',
        endpointUrl: FIXTURE_URL,
        documentUrl: 'http://nas.local/.well-known/graphql-services.json',
      },
      service: { name: 'io.github.cubicecho.shop.nas/api', title: 'Shop', endpoint: { url: FIXTURE_URL } },
      connection: { url: FIXTURE_URL, subscriptions: null, schemaUrl: null, requiredHeaders: [] },
    });

    const LIST = 'query { lanDiscovery { enabled upstreams { key title url state upstream { name discoveredKey } } } }';
    const before = await admin(LIST);
    expect(before.data.lanDiscovery).toEqual({
      enabled: true,
      upstreams: [{ key: KEY, title: 'Shop', url: FIXTURE_URL, state: 'NEW', upstream: null }],
    });

    const added = await admin(
      'mutation ($input: AddDiscoveredUpstreamInput!) { addDiscoveredUpstream(input: $input) { name url discoveredKey schema { typeCount } } }',
      { input: { key: KEY, name: 'Shop', headers: [] } },
    );
    expect(added.errors).toBeUndefined();
    expect(added.data.addDiscoveredUpstream).toMatchObject({ name: 'Shop', url: FIXTURE_URL, discoveredKey: KEY });

    const after = await admin(LIST);
    expect(after.data.lanDiscovery.upstreams[0]).toMatchObject({
      state: 'LINKED',
      upstream: { name: 'Shop', discoveredKey: KEY },
    });
  });

  it('refuses an unknown key with NOT_FOUND', async () => {
    const result = await admin(
      'mutation { addDiscoveredUpstream(input: { key: "nope", name: "Nope", headers: [] }) { id } }',
    );
    expect(result.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });
});
