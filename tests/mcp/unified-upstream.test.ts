// The upstream tools see the built-in `unified` upstream, driven through the whole app's /mcp with the SDK's client.
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import type { OpenedDatabase } from '../../server/db/client.ts';
import type { UnifiedGatewayService } from '../../server/gateway/unified-service.ts';
import { UNIFIED_UPSTREAM_ID, UNIFIED_UPSTREAM_NAME } from '../../server/gateway/unified-upstream.ts';
import { createApp } from '../../server/http/app.ts';
import { openTestDatabase } from '../db.ts';
import { createMemoUpstream, MEMO_ID, MEMO_UPSTREAM, MEMO_URL } from '../fixtures/memo-upstream.ts';

const KEY = 'test-key';

let opened: OpenedDatabase;
let unified: UnifiedGatewayService;
let client: Client;
let close: () => void = () => {};

/**
 * Calls one tool and reads its text.
 *
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns The first content block's text.
 */
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return content[0]?.text ?? '';
}

beforeAll(async () => {
  opened = await openTestDatabase();
  const built = createApp({
    db: opened.db,
    mcpKey: KEY,
    checkDatabase: () => opened.db.execute(sql`select 1`),
    fetch: createMemoUpstream().fetch,
  });
  unified = built.unified;
  await built.services.upstreams.add({ name: MEMO_UPSTREAM, url: MEMO_URL, headers: [] });
  unified.start();
  await unified.whenIdle();
  const server = built.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'x-api-key': KEY } } }),
  );
  close = () => server.close();
});
afterAll(async () => {
  await client.close();
  await unified.dispose();
  close();
  await opened.close();
});

describe('the upstream tools and the unified upstream', () => {
  it('list it as built in, beside the stored upstreams', async () => {
    const rows = JSON.parse(await call('list_upstreams'));
    expect(rows[0]).toMatchObject({
      name: UNIFIED_UPSTREAM_NAME,
      id: UNIFIED_UPSTREAM_ID,
      schemaCached: true,
      builtIn: true,
    });
    expect(rows[1]).toMatchObject({ name: MEMO_UPSTREAM, builtIn: false });
  });

  it('read and search its composed schema', async () => {
    expect(await call('get_schema', { upstream: UNIFIED_UPSTREAM_NAME, type: 'Query' })).toMatch(/memos: \[Memo!\]!/);
    expect(await call('search_schema', { upstream: UNIFIED_UPSTREAM_NAME, text: 'retitle' })).toMatch(
      /Mutation\.retitleMemo/,
    );
  });

  it('run a query on it', async () => {
    const body = JSON.parse(await call('run_query', { upstream: UNIFIED_UPSTREAM_NAME, query: '{ memos { id } }' }));
    expect(body).toEqual({ data: { memos: [{ id: MEMO_ID }] } });
  });
});
