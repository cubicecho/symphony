// The unified API through the whole app: a concept saved over the admin API recomposes the gateway, and
// /unified/graphql then serves it beside its member upstream. wiring.ts is still a stub, so the app runs
// FAKE_WIRING_FUNCTIONS; once it is implemented, drop `wiringFunctions` below.
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { ErrorCode } from '../../server/core/errors.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import type { UnifiedGatewayService } from '../../server/gateway/unified-service.ts';
import { CONCEPT_SOURCE_NAME } from '../../server/gateway/wiring.ts';
import { createApp } from '../../server/http/app.ts';
import { openTestDatabase } from '../db.ts';
import {
  createMemoUpstream,
  FAKE_WIRING_FUNCTIONS,
  MEMO_UPSTREAM,
  MEMO_URL,
  noteConcept,
} from '../fixtures/memo-upstream.ts';

let opened: OpenedDatabase;
let unified: UnifiedGatewayService;
let base = '';
let close: () => void = () => {};

/**
 * Posts one operation to an endpoint of the app.
 *
 * @param path - `/graphql` or `/unified/graphql`.
 * @param query - The document.
 * @param [variables] - Its variables.
 * @returns The status and body.
 */
async function post(path: string, query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: await response.json() };
}

const STATUS =
  '{ unifiedStatus { state endpoint sources { name kind } problems { kind message } lastError { message } } }';

beforeAll(async () => {
  opened = await openTestDatabase();
  const built = createApp({
    db: opened.db,
    mcpKey: 'test-key',
    checkDatabase: () => opened.db.execute(sql`select 1`),
    fetch: createMemoUpstream().fetch,
    wiringFunctions: FAKE_WIRING_FUNCTIONS,
  });
  unified = built.unified;
  const server = built.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(async () => {
  await unified.dispose();
  close();
  await opened.close();
});

describe('the unified API', () => {
  it('answers 503 until its first composition succeeds', async () => {
    const { status, body } = await post('/unified/graphql', '{ __typename }');
    expect(status).toBe(503);
    expect(body.errors[0].message).toMatch(/starting/);
  });

  it('serves the upstreams once started', async () => {
    await post('/graphql', 'mutation($input: AddUpstreamInput!) { addUpstream(input: $input) { id } }', {
      input: { name: MEMO_UPSTREAM, url: MEMO_URL, headers: [] },
    });
    unified.start();
    await unified.whenIdle();
    const { body } = await post('/graphql', STATUS);
    expect(body.data.unifiedStatus).toMatchObject({
      state: 'READY',
      endpoint: '/unified/graphql',
      sources: [{ name: MEMO_UPSTREAM, kind: 'graphql' }],
      lastError: null,
    });
    const served = await post('/unified/graphql', '{ memos { id title } }');
    expect(served.body).toEqual({ data: { memos: [{ id: 'm1', title: 'First' }] } });
  });

  it('refuses a concept that does not fit, with located problems', async () => {
    const definition = noteConcept('Broken', { fetch: 'query ($id: ID!) { memo(id: $id) { nope } }' });
    const { body } = await post('/graphql', 'mutation($d: JSON!) { saveConcept(definition: $d) { id } }', {
      d: definition,
    });
    expect(body.errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
    expect(body.errors[0].extensions.problems.length).toBeGreaterThan(0);
  });

  it('recomposes when a concept is saved, then serves the concept beside its member', async () => {
    const { body } = await post(
      '/graphql',
      'mutation($d: JSON!) { saveConcept(definition: $d) { name servable problems { message } } }',
      { d: noteConcept() },
    );
    expect(body.data.saveConcept).toEqual({ name: 'Note', servable: true, problems: [] });
    await unified.whenIdle();
    const status = await post('/graphql', STATUS);
    expect(status.body.data.unifiedStatus.sources).toEqual([
      { name: MEMO_UPSTREAM, kind: 'graphql' },
      { name: CONCEPT_SOURCE_NAME, kind: 'schema' },
    ]);
    const served = await post('/unified/graphql', '{ concepts noteType: __type(name: "Note") { name } memos { id } }');
    expect(served.body).toEqual({ data: { concepts: ['Note'], noteType: { name: 'Note' }, memos: [{ id: 'm1' }] } });
  });

  it('lists concepts and the effective wiring over the admin API', async () => {
    const { body } = await post(
      '/graphql',
      '{ concepts { name servable } concept(idOrName: "Note") { definition } sourceWiring { source override } }',
    );
    expect(body.data.concepts).toEqual([{ name: 'Note', servable: true }]);
    expect(body.data.concept.definition).toEqual(noteConcept());
    expect(body.data.sourceWiring).toEqual([{ source: MEMO_UPSTREAM, override: null }]);
  });

  it('sets and clears a wiring override over the admin API', async () => {
    const set = await post(
      '/graphql',
      'mutation($o: JSON!) { setWiringOverride(source: "field notes", override: $o) { source renames { types { from to } } } }',
      { o: { renames: { types: { Memo: 'FieldMemo' } } } },
    );
    expect(set.body.data.setWiringOverride).toEqual({
      source: MEMO_UPSTREAM,
      renames: { types: [{ from: 'Memo', to: 'FieldMemo' }] },
    });
    await unified.whenIdle();
    const renamed = await post('/unified/graphql', '{ memos { __typename } }');
    expect(renamed.body).toEqual({ data: { memos: [{ __typename: 'FieldMemo' }] } });
    const cleared = await post('/graphql', 'mutation { clearWiringOverride(source: "field notes") }');
    expect(cleared.body.data.clearWiringOverride).toBe(true);
  });

  it('recomposes without a removed concept', async () => {
    const concept = await post('/graphql', '{ concept(idOrName: "Note") { id } }');
    const removed = await post('/graphql', 'mutation($id: ID!) { removeConcept(id: $id) }', {
      id: concept.body.data.concept.id,
    });
    expect(removed.body.data.removeConcept).toBe(true);
    await unified.whenIdle();
    const status = await post('/graphql', STATUS);
    expect(status.body.data.unifiedStatus.sources).toEqual([{ name: MEMO_UPSTREAM, kind: 'graphql' }]);
  });
});
