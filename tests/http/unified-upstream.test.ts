// The built-in `unified` upstream through the whole app: it is listed with the served supergraph's schema, the
// proxy runs it in-process, it can't be changed, and its modules are re-checked whenever a recompose changes it,
// including modules that read it beside a stored upstream.
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { buildClientSchema, getIntrospectionQuery, type IntrospectionQuery, printSchema } from 'graphql';
import { ErrorCode } from '../../server/core/errors.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import type { UnifiedGatewayService } from '../../server/gateway/unified-service.ts';
import { UNIFIED_UPSTREAM_ID, UNIFIED_UPSTREAM_NAME } from '../../server/gateway/unified-upstream.ts';
import { createApp } from '../../server/http/app.ts';
import { openTestDatabase } from '../db.ts';
import { createMemoUpstream, MEMO_ID, MEMO_UPSTREAM, MEMO_URL, noteConcept } from '../fixtures/memo-upstream.ts';

/** A concept entity's id: a UUID. No such note exists; reading it answers null. */
const NOTE_ID = '3f2b8c1e-9d4a-4c6b-8e2f-1a7d5c9b0e44';

/** A module over the concept's query, which only the unified API has. */
const NOTE_MODULE = `
import { gql, useQuery } from 'symphony';
import { CardLayout } from '@/components/card-layout';

const NOTE = gql\`query Note { note(id: "${NOTE_ID}") { title } }\`;

export default function Note() {
  const { data } = useQuery(NOTE);
  return <CardLayout title="Note" contentSlot={<p>{data?.note?.title ?? ''}</p>} />;
}
`;

/** A module reading the memo upstream by default and the unified API's concept query through `gql.from`. */
const MIXED_MODULE = `
import { gql, useQuery } from 'symphony';
import { CardLayout } from '@/components/card-layout';

const MEMOS = gql\`query Memos { memos { id title } }\`;
const NOTE = gql.from('unified')\`query Note { note(id: "${NOTE_ID}") { title } }\`;

export default function Mixed() {
  const memos = useQuery(MEMOS);
  const note = useQuery(NOTE);
  return <CardLayout title="Mixed" contentSlot={<p>{String(memos.data)}{String(note.data)}</p>} />;
}
`;

const UPSTREAMS = '{ upstreams { id name url builtIn proxyPath schema { sdl hash } } }';
const MODULE = 'query($id: ID!) { module(id: $id) { status version errors { message } upstreams { name proxyPath } } }';
const SAVE_MODULE =
  'mutation($input: SaveModuleInput!) { saveModule(input: $input) { id status errors { message } upstreams { name } } }';

let opened: OpenedDatabase;
let unified: UnifiedGatewayService;
let base = '';
let close: () => void = () => {};

/**
 * Posts one operation to a path of the app.
 *
 * @param path - `/graphql`, `/unified/graphql` or a `/proxy/…` path.
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

/**
 * Saves the Note concept, or removes it, and waits for the recompose.
 *
 * @param isServed - Whether the concept should be served afterwards.
 */
async function setNoteConcept(isServed: boolean): Promise<void> {
  if (isServed) {
    await post('/graphql', 'mutation($d: JSON!) { saveConcept(definition: $d) { id } }', { d: noteConcept() });
  } else {
    const found = await post('/graphql', '{ concept(idOrName: "Note") { id } }');
    await post('/graphql', 'mutation($id: ID!) { removeConcept(id: $id) }', { id: found.body.data.concept.id });
  }
  await unified.whenIdle();
}

beforeAll(async () => {
  opened = await openTestDatabase();
  const built = createApp({
    db: opened.db,
    mcpKey: 'test-key',
    checkDatabase: () => opened.db.execute(sql`select 1`),
    fetch: createMemoUpstream().fetch,
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

describe('the unified upstream', () => {
  let moduleId = '';
  let mixedId = '';

  it('is listed first, built in, with no schema before the first composition', async () => {
    const { body } = await post('/graphql', UPSTREAMS);
    expect(body.data.upstreams).toEqual([
      {
        id: UNIFIED_UPSTREAM_ID,
        name: UNIFIED_UPSTREAM_NAME,
        url: '/unified/graphql',
        builtIn: true,
        proxyPath: `/proxy/${UNIFIED_UPSTREAM_ID}`,
        schema: null,
      },
    ]);
    const proxied = await post(`/proxy/${UNIFIED_UPSTREAM_NAME}`, '{ __typename }');
    expect(proxied.body.errors[0].extensions.code).toBe(ErrorCode.UpstreamFailed);
  });

  it('has the schema /unified/graphql serves once composed', async () => {
    await post('/graphql', 'mutation($input: AddUpstreamInput!) { addUpstream(input: $input) { id } }', {
      input: { name: MEMO_UPSTREAM, url: MEMO_URL, headers: [] },
    });
    unified.start();
    await setNoteConcept(true);
    const { body } = await post('/graphql', UPSTREAMS);
    const [listed, memo] = body.data.upstreams;
    expect(memo).toMatchObject({ name: MEMO_UPSTREAM, builtIn: false });
    const introspected = await post('/unified/graphql', getIntrospectionQuery({ descriptions: true }));
    const served = printSchema(buildClientSchema(introspected.body.data as IntrospectionQuery));
    expect(listed.schema.sdl).toBe(served);
    expect(listed.schema.sdl).toMatch(/note\(id: ID!\): Note/);
  });

  it('answers through the proxy in-process, checking requests against its schema first', async () => {
    const answered = await post(`/proxy/${UNIFIED_UPSTREAM_ID}`, '{ memos { id title } }');
    expect(answered.body).toEqual({ data: { memos: [{ id: MEMO_ID, title: 'First' }] } });
    const refused = await post(`/proxy/${UNIFIED_UPSTREAM_ID}`, '{ memos { nope } }');
    expect(refused.body.errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
  });

  it('cannot be edited, refreshed or deleted, and its name cannot be taken', async () => {
    const input = { name: UNIFIED_UPSTREAM_NAME, url: MEMO_URL, headers: [] };
    const attempts = [
      post('/graphql', 'mutation($input: AddUpstreamInput!) { addUpstream(input: $input) { id } }', { input }),
      post('/graphql', 'mutation($input: UpdateUpstreamInput!) { updateUpstream(input: $input) { id } }', {
        input: { ...input, id: UNIFIED_UPSTREAM_ID, name: 'renamed' },
      }),
      post('/graphql', 'mutation($id: ID!) { refreshSchema(id: $id) { id } }', { id: UNIFIED_UPSTREAM_ID }),
      post('/graphql', 'mutation($id: ID!) { deleteUpstream(id: $id) }', { id: UNIFIED_UPSTREAM_NAME }),
    ];
    for (const { body } of await Promise.all(attempts)) {
      expect(body.errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
    }
    const { body } = await post('/graphql', UPSTREAMS);
    expect(body.data.upstreams.map((upstream: { name: string }) => upstream.name)).toEqual([
      UNIFIED_UPSTREAM_NAME,
      MEMO_UPSTREAM,
    ]);
  });

  it('is never composed into itself', () => {
    expect(unified.status().sources.map((source) => source.name)).not.toContain(UNIFIED_UPSTREAM_NAME);
  });

  it('takes a module written against it', async () => {
    const { body } = await post('/graphql', SAVE_MODULE, {
      input: { name: 'Note', upstreamIds: [UNIFIED_UPSTREAM_ID], source: NOTE_MODULE },
    });
    expect(body.data.saveModule).toMatchObject({ status: 'READY', upstreams: [{ name: UNIFIED_UPSTREAM_NAME }] });
    moduleId = body.data.saveModule.id;
  });

  it('takes a module reading a stored upstream and the unified one, each document checked against its own', async () => {
    const { body } = await post('/graphql', SAVE_MODULE, {
      input: { name: 'Mixed', upstreamIds: [MEMO_UPSTREAM, UNIFIED_UPSTREAM_ID], source: MIXED_MODULE },
    });
    expect(body.data.saveModule).toMatchObject({
      status: 'READY',
      errors: [],
      upstreams: [{ name: MEMO_UPSTREAM }, { name: UNIFIED_UPSTREAM_NAME }],
    });
    mixedId = body.data.saveModule.id;
    // The memo upstream has no note query: a plain gql document for it is refused.
    const wrong = await post('/graphql', SAVE_MODULE, {
      input: { name: 'Wrong', upstreamIds: [MEMO_UPSTREAM], source: NOTE_MODULE },
    });
    expect(wrong.body.data.saveModule.status).toBe('FAILED');
    expect(wrong.body.data.saveModule.errors[0].message).toMatch(/note/);
    await post('/graphql', 'mutation($id: ID!) { deleteModule(id: $id) }', { id: wrong.body.data.saveModule.id });
  });

  it("serves each of the mixed module's documents through its own upstream's proxy path", async () => {
    const { body } = await post('/graphql', MODULE, { id: mixedId });
    const paths = new Map<string, string>(
      body.data.module.upstreams.map((upstream: { name: string; proxyPath: string }) => [
        upstream.name,
        upstream.proxyPath,
      ]),
    );
    const memos = await post(paths.get(MEMO_UPSTREAM) ?? '', 'query Memos { memos { id title } }');
    expect(memos.body).toEqual({ data: { memos: [{ id: MEMO_ID, title: 'First' }] } });
    const note = await post(paths.get(UNIFIED_UPSTREAM_NAME) ?? '', `query Note { note(id: "${NOTE_ID}") { title } }`);
    expect(note.body).toEqual({ data: { note: null } });
  });

  it('refuses a module with no upstreams or one listed twice', async () => {
    const none = await post('/graphql', SAVE_MODULE, { input: { name: 'None', upstreamIds: [], source: NOTE_MODULE } });
    const twice = await post('/graphql', SAVE_MODULE, {
      input: { name: 'Twice', upstreamIds: [UNIFIED_UPSTREAM_ID, UNIFIED_UPSTREAM_NAME], source: NOTE_MODULE },
    });
    for (const { body } of [none, twice]) {
      expect(body.errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
    }
  });

  it('marks its module failing when a recompose drops a field it uses, and ready again when it is back', async () => {
    await setNoteConcept(false);
    const failing = await post('/graphql', MODULE, { id: moduleId });
    expect(failing.body.data.module).toMatchObject({ status: 'FAILED', version: 2 });
    expect(failing.body.data.module.errors[0].message).toMatch(/note/);
    // The mixed module reads unified second, and is re-checked all the same.
    const mixedFailing = await post('/graphql', MODULE, { id: mixedId });
    expect(mixedFailing.body.data.module).toMatchObject({ status: 'FAILED', version: 2 });
    await setNoteConcept(true);
    const ready = await post('/graphql', MODULE, { id: moduleId });
    expect(ready.body.data.module).toMatchObject({ status: 'READY', version: 3, errors: [] });
    const mixedReady = await post('/graphql', MODULE, { id: mixedId });
    expect(mixedReady.body.data.module).toMatchObject({ status: 'READY', version: 3, errors: [] });
  });

  it('leaves its modules alone when a recompose serves the same schema', async () => {
    unified.requestRecompose('test');
    await unified.whenIdle();
    const { body } = await post('/graphql', MODULE, { id: moduleId });
    expect(body.data.module).toMatchObject({ status: 'READY', version: 3 });
  });

  it('still deletes a stored upstream with every module that lists it, in any position', async () => {
    const memo = await post('/graphql', `{ upstream(id: "${MEMO_UPSTREAM}") { id } }`);
    const memoId = memo.body.data.upstream.id;
    const saved = await post('/graphql', SAVE_MODULE, {
      input: { name: 'Memo', upstreamIds: [memoId], source: NOTE_MODULE },
    });
    const second = await post('/graphql', SAVE_MODULE, {
      input: { name: 'Memo second', upstreamIds: [UNIFIED_UPSTREAM_ID, memoId], source: NOTE_MODULE },
    });
    const removedIds = [saved.body.data.saveModule.id, second.body.data.saveModule.id, mixedId];
    await post('/graphql', 'mutation($id: ID!) { deleteUpstream(id: $id) }', { id: memoId });
    for (const id of removedIds) {
      const gone = await post('/graphql', MODULE, { id });
      expect(gone.body.data.module).toBeNull();
    }
    const kept = await post('/graphql', MODULE, { id: moduleId });
    expect(kept.body.data.module).not.toBeNull();
  });
});
