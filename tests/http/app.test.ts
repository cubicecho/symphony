import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { createApp } from '../../server/http/app.ts';
import { openTestDatabase } from '../db.ts';
import { FIXTURE_URL, fixtureFetch } from '../fixtures/upstream.ts';

const MODULE_SOURCE = `
import { gql, useQuery } from 'symphony';
import { CardLayout } from '@/components/card-layout';

const ORDERS = gql\`query Orders { orders(first: 2) { id total } }\`;

export default function Orders() {
  const { data } = useQuery(ORDERS);
  return <CardLayout title="Orders" contentSlot={<p>{data?.orders.length ?? 0}</p>} />;
}
`;

let opened: OpenedDatabase;
let base = '';
let close: () => void = () => {};

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
  const { app } = createApp({
    db: opened.db,
    mcpKey: 'test-key',
    checkDatabase: () => opened.db.execute(sql`select 1`),
    fetch: fixtureFetch(),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(async () => {
  close();
  await opened.close();
});

describe('the app', () => {
  let upstreamId = '';
  let moduleId = '';

  it('answers /healthz', async () => {
    const response = await fetch(`${base}/healthz`);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('adds an upstream over the admin API, introspecting it', async () => {
    const body = await admin(
      'mutation($input: AddUpstreamInput!) { addUpstream(input: $input) { id proxyPath schema { typeCount } } }',
      { input: { name: 'shop', url: FIXTURE_URL, headers: [] } },
    );
    upstreamId = body.data.addUpstream.id;
    expect(body.data.addUpstream.schema.typeCount).toBeGreaterThan(0);
    expect(body.data.addUpstream.proxyPath).toBe(`/proxy/${upstreamId}`);
  });

  it('proxies queries and refuses invalid ones', async () => {
    const post = (query: string) =>
      fetch(`${base}/proxy/${upstreamId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      }).then((response) => response.json());
    expect(await post('{ customers { name } }')).toEqual({
      data: { customers: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }] },
    });
    const refused = await post('{ customers { password } }');
    expect(refused.errors[0].message).toMatch(/password/);
  });

  it('saves and compiles a module, then serves its code by version', async () => {
    const body = await admin(
      'mutation($input: SaveModuleInput!) { saveModule(input: $input) { id status version codeUrl errors { message } } }',
      { input: { name: 'Orders', upstreamIds: [upstreamId], source: MODULE_SOURCE } },
    );
    const saved = body.data.saveModule;
    expect(saved.errors).toEqual([]);
    expect(saved.status).toBe('READY');
    moduleId = saved.id;
    const code = await fetch(`${base}${saved.codeUrl}`);
    expect(code.headers.get('content-type')).toMatch(/javascript/);
    expect(await code.text()).toContain('require(');
    const stale = await fetch(`${base}/modules/${moduleId}/99.js`);
    expect(stale.status).toBe(404);
  });

  it('keeps a failing module with its errors', async () => {
    const body = await admin(
      'mutation($input: SaveModuleInput!) { saveModule(input: $input) { status version codeUrl errors { stage line } } }',
      {
        input: {
          id: moduleId,
          name: 'Orders',
          upstreamIds: [upstreamId],
          source: MODULE_SOURCE.replace('total', 'nope'),
        },
      },
    );
    expect(body.data.saveModule).toMatchObject({ status: 'FAILED', version: 2, codeUrl: null });
    expect(body.data.saveModule.errors[0]).toMatchObject({ stage: 'GRAPHQL' });
  });

  it('places a module on Home', async () => {
    const body = await admin(
      'mutation($input: AddItemInput!) { addItem(input: $input) { slug items { columnSpan module { name } } } }',
      { input: { pageSlug: 'home', moduleId } },
    );
    expect(body.data.addItem.items).toEqual([{ columnSpan: 2, module: { name: 'Orders' } }]);
  });

  it('shuts /mcp to callers without the key', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });
});
