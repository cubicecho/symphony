// Drives /mcp through a real Express app and the SDK's own client, the way Claude Code reaches it.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_DEFAULTS } from '../../server/core/defaults.ts';
import { createMcpHandler } from '../../server/mcp/endpoint.ts';
import { BROKEN_MARKER, createFakeServices, FAKE_ERROR, FAKE_UPSTREAM } from './fake-services.ts';

const KEY = 'test-key';

interface Running {
  server: Server;
  url: string;
}

/**
 * Starts an app with /mcp on an ephemeral port.
 *
 * @param key - The server's key.
 * @returns The listening server and the endpoint's URL.
 */
async function start(key: string): Promise<Running & { calls: ReturnType<typeof createFakeServices>['calls'] }> {
  const { services, calls } = createFakeServices();
  const app = express();
  app.all(
    '/mcp',
    express.json({ limit: HTTP_DEFAULTS.bodyLimit }),
    createMcpHandler(services, { key, version: '9.9.9' }),
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/mcp`, calls };
}

/**
 * Connects the SDK client with some headers.
 *
 * @param url - The endpoint.
 * @param headers - Sent on every request.
 * @returns The connected client.
 */
async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

/**
 * Reads the text of a tool result.
 *
 * @param result - What callTool answered.
 * @returns The first content block's text.
 */
function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content[0]?.text ?? '';
}

describe('/mcp', () => {
  let running: Awaited<ReturnType<typeof start>>;
  let client: Client;

  beforeAll(async () => {
    running = await start(KEY);
    client = await connect(running.url, { 'x-api-key': KEY });
  });

  afterAll(async () => {
    await client.close();
    await new Promise((resolve) => running.server.close(resolve));
  });

  it('refuses a call without a key', async () => {
    const response = await fetch(running.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('refuses a wrong key', async () => {
    await expect(connect(running.url, { 'x-api-key': 'nope' })).rejects.toThrow();
    const response = await fetch(running.url, { method: 'POST', headers: { 'x-api-key': 'nope' }, body: '{}' });
    expect(response.status).toBe(401);
  });

  it('accepts the key as a Bearer token', async () => {
    const bearer = await connect(running.url, { authorization: `Bearer ${KEY}` });
    expect((await bearer.listTools()).tools.length).toBeGreaterThan(0);
    await bearer.close();
  });

  it('answers GET with 405', async () => {
    const response = await fetch(running.url, { headers: { 'x-api-key': KEY } });
    expect(response.status).toBe(405);
  });

  it('lists the tools', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_upstreams',
        'get_schema',
        'search_schema',
        'run_query',
        'list_components',
        'get_component_docs',
        'get_module_contract',
        'check_module',
        'submit_module',
        'list_modules',
        'get_module',
        'list_concepts',
        'get_concept',
        'save_concept',
        'remove_concept',
        'get_wiring',
        'set_wiring_override',
        'clear_wiring_override',
        'get_unified_status',
      ]),
    );
  });

  it('lists upstreams without their headers', async () => {
    const text = textOf(await client.callTool({ name: 'list_upstreams', arguments: {} }));
    const rows = JSON.parse(text);
    expect(rows[0]).toMatchObject({ name: FAKE_UPSTREAM, schemaCached: true });
    expect(rows[1]).toMatchObject({ name: 'empty', schemaCached: false, fetchedAt: null });
    expect(text).not.toContain('SYMPHONY_SECRET');
  });

  it('gives the whole schema', async () => {
    const text = textOf(await client.callTool({ name: 'get_schema', arguments: { upstream: FAKE_UPSTREAM } }));
    expect(text).toContain('type Customer');
    expect(text).toContain('shipOrder');
  });

  it('gives one type and the types it references', async () => {
    const text = textOf(
      await client.callTool({ name: 'get_schema', arguments: { upstream: FAKE_UPSTREAM, type: 'Order' } }),
    );
    expect(text.startsWith('type Order')).toBe(true);
    expect(text).toContain('enum OrderStatus');
    expect(text).toContain('type Customer');
    expect(text).not.toContain('type Query');
    expect(text).not.toContain('scalar String');
  });

  it('takes Query as a type', async () => {
    const text = textOf(
      await client.callTool({ name: 'get_schema', arguments: { upstream: FAKE_UPSTREAM, type: 'Query' } }),
    );
    expect(text).toContain('orders(first: Int = 20, status: OrderStatus): [Order!]!');
    expect(text).toContain('type Order');
  });

  it('suggests close names for an unknown type', async () => {
    const result = await client.callTool({ name: 'get_schema', arguments: { upstream: FAKE_UPSTREAM, type: 'Ordr' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Did you mean .*Order/);
  });

  it('says when an upstream has no cached schema', async () => {
    const result = await client.callTool({ name: 'get_schema', arguments: { upstream: 'empty' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no cached schema');
  });

  it('suggests close upstream names', async () => {
    const result = await client.callTool({ name: 'get_schema', arguments: { upstream: 'shoop' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Did you mean shop');
  });

  it('searches the schema', async () => {
    const text = textOf(
      await client.callTool({ name: 'search_schema', arguments: { upstream: FAKE_UPSTREAM, text: 'NEWEST' } }),
    );
    expect(text).toBe('Query.orders(first: Int, status: OrderStatus): [Order!]!  — Newest first.');
    const status = textOf(
      await client.callTool({ name: 'search_schema', arguments: { upstream: FAKE_UPSTREAM, text: 'status' } }),
    );
    expect(status).toContain('enum OrderStatus');
    expect(status).toContain('Order.status: OrderStatus!');
  });

  it('runs a query through the upstream service', async () => {
    const text = textOf(
      await client.callTool({ name: 'run_query', arguments: { upstream: FAKE_UPSTREAM, query: '{ orders { id } }' } }),
    );
    expect(JSON.parse(text)).toEqual({ data: { orders: [{ id: 'o3' }] } });
    expect(running.calls.executed).toEqual([{ id: 'u1', query: '{ orders { id } }' }]);
  });

  it('lists components and gives their docs', async () => {
    const components = JSON.parse(textOf(await client.callTool({ name: 'list_components', arguments: {} })));
    expect(components).toEqual(
      expect.arrayContaining([expect.objectContaining({ importPath: '@/components/card-layout' })]),
    );
    const docs = textOf(await client.callTool({ name: 'get_component_docs', arguments: { name: 'CardLayout' } }));
    expect(docs).toContain('<!-- props:CardLayout -->');
    const missing = await client.callTool({ name: 'get_component_docs', arguments: { name: 'CardLayot' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('CardLayout');
  });

  it('serves the module contract as a tool and a resource', async () => {
    const text = textOf(await client.callTool({ name: 'get_module_contract', arguments: {} }));
    expect(text).toContain('# Writing a Symphony module');
    const resource = await client.readResource({ uri: 'contract://module' });
    expect(resource.contents[0]).toMatchObject({ text });
  });

  it('lists and reads upstream schemas as resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((one) => one.uri)).toContain(`schema://${FAKE_UPSTREAM}`);
    const resource = await client.readResource({ uri: `schema://${FAKE_UPSTREAM}` });
    expect(resource.contents[0]).toMatchObject({ text: expect.stringContaining('type Order') });
  });

  it('checks a module without saving it', async () => {
    const text = textOf(
      await client.callTool({
        name: 'check_module',
        arguments: { upstream: FAKE_UPSTREAM, source: `x ${BROKEN_MARKER}` },
      }),
    );
    expect(text).toContain('not ok');
    expect(text).toContain(`3:7 [GRAPHQL] ${FAKE_ERROR.message}`);
    const listed = textOf(await client.callTool({ name: 'list_modules', arguments: {} }));
    expect(JSON.parse(listed)).toEqual([]);
  });

  it('submits a module, passes its errors through, and takes a fix under the same id', async () => {
    const failed = textOf(
      await client.callTool({
        name: 'submit_module',
        arguments: { name: 'Orders', upstream: FAKE_UPSTREAM, source: `x ${BROKEN_MARKER}` },
      }),
    );
    expect(failed).toContain('id: m1');
    expect(failed).toContain('status: FAILED');
    expect(failed).toContain('ok: false');
    expect(failed).toContain(`3:7 [GRAPHQL] ${FAKE_ERROR.message}`);
    expect(failed).toContain('again with id "m1"');

    const fixed = textOf(
      await client.callTool({
        name: 'submit_module',
        arguments: { id: 'm1', name: 'Orders', upstream: FAKE_UPSTREAM, source: 'export default function A() {}' },
      }),
    );
    expect(fixed).toContain('version: 2');
    expect(fixed).toContain('ok: true');
    expect(fixed).toContain('a person can now place it on a page in Symphony');

    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_modules', arguments: {} })));
    expect(listed).toEqual([{ id: 'm1', name: 'Orders', upstream: FAKE_UPSTREAM, status: 'READY', version: 2 }]);
    const module = textOf(await client.callTool({ name: 'get_module', arguments: { id: 'm1' } }));
    expect(module).toContain('export default function A() {}');
  });

  it('saves, gets and removes a concept, and refuses one with problems', async () => {
    const refused = await client.callTool({ name: 'save_concept', arguments: { definition: { fields: [] } } });
    expect(refused.isError).toBe(true);
    const saved = await client.callTool({ name: 'save_concept', arguments: { definition: { name: 'Note' } } });
    expect(JSON.parse(textOf(saved)).saved).toMatchObject({ name: 'Note', servable: true });
    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_concepts', arguments: {} })));
    expect(listed).toEqual([expect.objectContaining({ name: 'Note', problemCount: 0 })]);
    const got = JSON.parse(textOf(await client.callTool({ name: 'get_concept', arguments: { concept: 'Note' } })));
    expect(got.definition).toEqual({ name: 'Note' });
    const missing = await client.callTool({ name: 'get_concept', arguments: { concept: 'Nte' } });
    expect(textOf(missing)).toContain('Note');
    const removed = await client.callTool({ name: 'remove_concept', arguments: { concept: 'Note' } });
    expect(JSON.parse(textOf(removed))).toEqual({ removed: 'Note' });
  });

  it('reads the wiring and the unified status', async () => {
    const wiring = JSON.parse(textOf(await client.callTool({ name: 'get_wiring', arguments: {} })));
    expect(wiring).toEqual({ wiring: [], problems: [] });
    const none = await client.callTool({ name: 'get_wiring', arguments: { source: FAKE_UPSTREAM } });
    expect(none.isError).toBe(true);
    const cleared = JSON.parse(
      textOf(await client.callTool({ name: 'clear_wiring_override', arguments: { source: FAKE_UPSTREAM } })),
    );
    expect(cleared).toEqual({ source: FAKE_UPSTREAM, cleared: false });
    const status = JSON.parse(textOf(await client.callTool({ name: 'get_unified_status', arguments: {} })));
    expect(status).toMatchObject({ endpoint: '/unified/graphql', state: 'starting', lastError: null });
  });

  it('turns a thrown NOT_FOUND into an error result', async () => {
    const result = await client.callTool({ name: 'get_module', arguments: { id: 'missing' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No module "missing"');
  });
});

describe('/mcp with no key set', () => {
  let running: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    running = await start('');
  });

  afterAll(async () => {
    await new Promise((resolve) => running.server.close(resolve));
  });

  it('refuses every call and says why', async () => {
    const response = await fetch(running.url, { method: 'POST', headers: { 'x-api-key': '' }, body: '{}' });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toContain('SYMPHONY_MCP_KEY');
    await expect(connect(running.url, { 'x-api-key': 'anything' })).rejects.toThrow();
  });
});
