import { ErrorCode } from '../../server/core/errors.ts';
import type { UpstreamService } from '../../server/core/services.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { createUpstreamService } from '../../server/upstreams/upstream-service.ts';
import { openTestDatabase } from '../db.ts';
import { FIXTURE_URL, fixtureFetch } from '../fixtures/upstream.ts';

const TOKEN = 'fixture-token';
let opened: OpenedDatabase;
let service: UpstreamService;

beforeAll(async () => {
  opened = await openTestDatabase();
  service = createUpstreamService({
    db: opened.db,
    fetch: fixtureFetch({ token: TOKEN }),
    env: { SYMPHONY_SHOP_TOKEN: TOKEN, OTHER_SECRET: 'nope' },
  });
});
afterAll(() => opened.close());

const shopHeaders = [{ name: 'authorization', value: 'Bearer ${env:SYMPHONY_SHOP_TOKEN}' }];

describe('upstreams', () => {
  it('introspects on add and caches the schema', async () => {
    const upstream = await service.add({ name: 'shop', url: FIXTURE_URL, headers: shopHeaders });
    expect(upstream.schema?.sdl).toContain('type Order');
    expect(upstream.schema?.typeCount).toBeGreaterThan(3);
    expect(upstream.headers[0]?.value).toBe('Bearer ${env:SYMPHONY_SHOP_TOKEN}');
    const again = await service.find('shop');
    expect(again?.schema?.hash).toBe(upstream.schema?.hash);
  });

  it('keeps an upstream whose introspection fails', async () => {
    const upstream = await service.add({ name: 'locked', url: FIXTURE_URL, headers: [] });
    expect(upstream.schema).toBeNull();
    await expect(service.refresh('locked')).rejects.toMatchObject({
      extensions: { code: ErrorCode.UpstreamFailed },
    });
  });

  it('refuses a duplicate name and a bad URL', async () => {
    await expect(service.add({ name: 'shop', url: FIXTURE_URL, headers: [] })).rejects.toMatchObject({
      extensions: { code: ErrorCode.Conflict },
    });
    await expect(service.add({ name: 'x', url: 'ftp://nope', headers: [] })).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
  });

  it('proxies a valid query with the resolved header', async () => {
    const body = await service.execute('shop', { query: '{ orders(first: 1) { id total } }' });
    expect(body).toEqual({ data: { orders: [{ id: 'o3', total: 4200 }] } });
  });

  it('refuses a query that does not validate, without sending it', async () => {
    const body = await service.execute('shop', { query: '{ orders { nope } }' });
    expect(body.errors?.[0]?.message).toMatch(/nope/);
    expect(body.data).toBeUndefined();
  });

  it('refuses a secret outside the prefix, naming it but not its value', async () => {
    const upstream = await service.add({
      name: 'sneaky',
      url: FIXTURE_URL,
      headers: [{ name: 'x-leak', value: '${env:OTHER_SECRET}' }],
    });
    expect(upstream.schema).toBeNull();
    await expect(service.refresh('sneaky')).rejects.toThrow(/OTHER_SECRET must be named SYMPHONY_/);
  });

  it('deletes an upstream', async () => {
    const upstream = await service.find('locked');
    expect(await service.remove(upstream?.id ?? '')).toBe(true);
    expect(await service.find('locked')).toBeNull();
  });
});
