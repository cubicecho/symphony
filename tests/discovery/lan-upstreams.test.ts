import type { GraphqlServiceWatchHandlers, LanGraphqlService } from '@cubicecho/graphql-mdns-discovery/mdns';
import { ErrorCode } from '../../server/core/errors.ts';
import type { UpstreamService } from '../../server/core/services.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import {
  createLanUpstreamService,
  type LanUpstreams,
  SYMPHONY_ROLE_META,
} from '../../server/discovery/lan-upstreams.ts';
import { createUpstreamService } from '../../server/upstreams/upstream-service.ts';
import { openTestDatabase } from '../db.ts';
import { FIXTURE_URL, fixtureFetch } from '../fixtures/upstream.ts';

const TOKEN = 'fixture-token';
const MOVED_URL = 'http://fixture.test/v2/graphql';

let opened: OpenedDatabase;
let upstreams: UpstreamService;

beforeAll(async () => {
  opened = await openTestDatabase();
  upstreams = createUpstreamService({ db: opened.db, fetch: fixtureFetch({ token: TOKEN }) });
});
afterAll(() => opened.close());

/**
 * A found API, as the watcher reports it.
 *
 * @param name - The last part of its service name; the key is `<instance>/<service name>`.
 * @param options - Its URL, required headers and `_meta`.
 * @returns The report.
 */
function found(
  name: string,
  options: { url?: string; requiredHeaders?: string[]; meta?: Record<string, unknown> } = {},
): LanGraphqlService {
  const { url = FIXTURE_URL, requiredHeaders = [], meta } = options;
  const serviceName = `io.github.cubicecho.test.nas/${name}`;
  const host = {
    name: 'Test on nas',
    host: 'nas.local',
    port: 80,
    addresses: ['192.168.1.20'],
    txt: { path: '/graphql', documentPath: '/.well-known/graphql-services.json', tls: false },
    origin: 'http://192.168.1.20',
    endpointUrl: url,
    documentUrl: 'http://192.168.1.20/.well-known/graphql-services.json',
  };
  return {
    key: `${host.name}/${serviceName}`,
    host,
    service: { name: serviceName, title: `Test ${name}`, endpoint: { url }, ...(meta ? { _meta: meta } : {}) },
    connection: { url, subscriptions: null, schemaUrl: null, requiredHeaders },
  };
}

/** A service over a watcher the test drives through the handlers it was given. */
async function setup(
  isWanted = true,
): Promise<{ lan: LanUpstreams; network: GraphqlServiceWatchHandlers; stopped: () => boolean }> {
  let network: GraphqlServiceWatchHandlers = { onUp: () => undefined };
  let isStopped = false;
  const lan = createLanUpstreamService({
    upstreams,
    isWanted: () => isWanted,
    startWatch: async (handlers) => {
      network = handlers;
      return {
        stop: async () => {
          isStopped = true;
        },
      };
    },
    log: () => undefined,
  });
  await lan.start();
  return {
    lan,
    network: { onUp: (api) => network.onUp(api), onDown: (api) => network.onDown?.(api) },
    stopped: () => isStopped,
  };
}

/** Waits for the follow-up writes a sighting starts in the background. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('LAN upstreams', () => {
  it('watches nothing, and lists nothing, unless LAN_DISCOVER is on', async () => {
    const { lan } = await setup(false);
    expect(lan.enabled()).toBe(false);
    expect(await lan.list()).toEqual([]);
  });

  it('lists what it finds, says which need a token, and skips another Symphony', async () => {
    const { lan, network } = await setup();
    network.onUp(found('open'));
    network.onUp(found('locked', { requiredHeaders: ['authorization'] }));
    network.onUp(found('symphony', { meta: { [SYMPHONY_ROLE_META]: 'unified' } }));
    const listed = await lan.list();
    expect(listed.map(({ serviceName, state }) => [serviceName.split('/')[1], state])).toEqual([
      ['open', 'NEW'],
      ['locked', 'NEEDS_TOKEN'],
    ]);
    expect(listed[1]).toMatchObject({ host: 'Test on nas', url: FIXTURE_URL, requiredHeaders: ['authorization'] });
  });

  it('adds a found API as an upstream, refusing it without the headers it requires', async () => {
    const { lan, network } = await setup();
    const api = found('shop', { requiredHeaders: ['authorization'] });
    network.onUp(api);
    await expect(lan.add({ key: api.key, name: 'Shop on nas', headers: [] })).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
    const added = await lan.add({
      key: api.key,
      name: 'Shop on nas',
      headers: [{ name: 'authorization', value: `Bearer ${TOKEN}` }],
    });
    expect(added).toMatchObject({ url: FIXTURE_URL, discoveredKey: api.key });
    expect(added.schema?.sdl).toContain('type Order');
    expect((await lan.list()).find((entry) => entry.key === api.key)).toMatchObject({
      state: 'LINKED',
      upstreamId: added.id,
    });
    await expect(lan.add({ key: api.key, name: 'Again', headers: [] })).rejects.toMatchObject({
      extensions: { code: ErrorCode.Conflict },
    });
    await upstreams.remove(added.id);
  });

  it('moves a linked upstream when its API moves, keeping its name and headers', async () => {
    const { lan, network } = await setup();
    const api = found('mover');
    network.onUp(api);
    const added = await lan.add({ key: api.key, name: 'Mover', headers: [{ name: 'x-team', value: 'blue' }] });
    network.onUp(found('mover', { url: MOVED_URL }));
    await settle();
    expect(await upstreams.find(added.id)).toMatchObject({
      name: 'Mover',
      url: MOVED_URL,
      headers: [{ name: 'x-team', value: 'blue' }],
      discoveredKey: api.key,
    });
    await upstreams.remove(added.id);
  });

  it('stops following once the operator types a URL by hand', async () => {
    const { lan, network } = await setup();
    const api = found('pinned');
    network.onUp(api);
    const added = await lan.add({ key: api.key, name: 'Pinned', headers: [] });
    await upstreams.update(added.id, { name: 'Pinned', url: 'http://elsewhere.test/graphql', headers: [] });
    network.onUp(found('pinned', { url: MOVED_URL }));
    await settle();
    expect(await upstreams.find(added.id)).toMatchObject({ url: 'http://elsewhere.test/graphql', discoveredKey: null });
    expect((await lan.list()).find((entry) => entry.key === api.key)?.state).toBe('NEW');
    await upstreams.remove(added.id);
  });

  it('marks an API that left as offline, keeps its upstream, and refuses to add it', async () => {
    const { lan, network, stopped } = await setup();
    const kept = found('kept');
    const gone = found('gone');
    network.onUp(kept);
    network.onUp(gone);
    const added = await lan.add({ key: kept.key, name: 'Kept', headers: [] });
    network.onDown?.(kept);
    network.onDown?.(gone);
    const states = Object.fromEntries((await lan.list()).map((entry) => [entry.key, entry.state]));
    expect(states).toEqual({ [kept.key]: 'OFFLINE', [gone.key]: 'OFFLINE' });
    expect(await upstreams.find(added.id)).not.toBeNull();
    await expect(lan.add({ key: gone.key, name: 'Gone', headers: [] })).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
    await lan.stop();
    expect(stopped()).toBe(true);
    expect(lan.enabled()).toBe(false);
    await upstreams.remove(added.id);
  });
});
