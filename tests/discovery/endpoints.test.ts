import type { AddressInfo } from 'node:net';
import { cardConnection, parseAiCatalog, parseServerCard } from '@cubicecho/mcp-discovery';
import { sql } from 'drizzle-orm';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { discoveryEndpoints } from '../../server/discovery/endpoints.ts';
import { createApp } from '../../server/http/app.ts';
import { openTestDatabase } from '../db.ts';

const KEY = 'test-key';

let opened: OpenedDatabase;
let base = '';
let close: () => void = () => {};

beforeAll(async () => {
  opened = await openTestDatabase();
  const { app } = createApp({ db: opened.db, mcpKey: KEY, checkDatabase: () => opened.db.execute(sql`select 1`) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(async () => {
  close();
  await opened.close();
});

describe('discovery documents', () => {
  it('serves the catalog without a key while /mcp still asks for one', async () => {
    const catalog = await fetch(`${base}/.well-known/ai-catalog.json`);
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('content-type')).toContain('application/ai-catalog+json');
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(mcp.status).toBe(401);
  });

  it('lists /mcp with a card on the address the client used', async () => {
    const catalog = parseAiCatalog(await (await fetch(`${base}/.well-known/ai-catalog.json`)).json(), 'test');
    expect(catalog.entries.map((entry) => new URL(entry.url ?? '').pathname)).toEqual(['/mcp/server-card']);

    const response = await fetch(`${base}/mcp/server-card`);
    expect(response.status).toBe(200);
    const card = parseServerCard(await response.json(), 'test');
    expect(card.repository?.url).toBe('https://github.com/cubicecho/symphony');
    expect(cardConnection(card)).toEqual({ url: `${base}/mcp`, requiredHeaders: ['Authorization'] });
    expect(JSON.stringify(card)).not.toContain(KEY);
  });

  it('names the card after the host, so two servers on one network stay apart', () => {
    const [endpoint] = discoveryEndpoints({ version: '1.0.0', host: 'NAS.lan' });
    expect(endpoint?.identifier).toBe('urn:air:nas.symphony:mcp:modules');
  });
});
