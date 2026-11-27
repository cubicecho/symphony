// Concept proposals through the whole app: propose over the admin API, submit the draft, revise it, accept it, and
// the unified API then serves the concept.
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { ErrorCode } from '../../server/core/errors.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import type { UnifiedGatewayService } from '../../server/gateway/unified-service.ts';
import { createApp } from '../../server/http/app.ts';
import { openTestDatabase } from '../db.ts';
import {
  createProposalUpstreams,
  PROPOSAL_SDLS,
  proposalUpstreamUrl,
  WAREHOUSE_CREATE,
} from '../fixtures/proposal-upstreams.ts';

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
 * @returns The body.
 */
async function post(path: string, query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

const PROPOSAL_FIELDS =
  'id name status source servable problems { member operation message } note concept { name servable }';

beforeAll(async () => {
  opened = await openTestDatabase();
  const built = createApp({
    db: opened.db,
    mcpKey: 'test-key',
    checkDatabase: () => opened.db.execute(sql`select 1`),
    fetch: createProposalUpstreams().fetch,
  });
  unified = built.unified;
  const server = built.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
  for (const [name] of PROPOSAL_SDLS) {
    await post('/graphql', 'mutation($input: AddUpstreamInput!) { addUpstream(input: $input) { id } }', {
      input: { name, url: proposalUpstreamUrl(name), headers: [] },
    });
  }
  unified.start();
  await unified.whenIdle();
});
afterAll(async () => {
  await unified.dispose();
  close();
  await opened.close();
});

describe('concept proposals over the admin API', () => {
  let draft: { name: string; definition: Record<string, unknown> };
  let proposalId = '';

  it('proposes concepts with reasons, problems and the candidates that are not ready', async () => {
    const { data } = await post(
      '/graphql',
      '{ proposeConcepts { drafts { name definition servable problems { message } reasons { about reason confidence } } notReady { name types { upstream type reason } } } }',
    );
    const [first] = data.proposeConcepts.drafts;
    expect(first).toMatchObject({ name: 'Widget', servable: false });
    expect(first.reasons).toContainEqual(expect.objectContaining({ about: 'warehouse create', confidence: 'LOW' }));
    expect(data.proposeConcepts.notReady[0].name).toBe('Gizmo');
    draft = first;
  });

  it('stores a submitted draft as a pending proposal, problems and all', async () => {
    const { data } = await post(
      '/graphql',
      `mutation($d: JSON!) { submitConceptProposal(definition: $d, source: GENERATED) { ${PROPOSAL_FIELDS} } }`,
      { d: draft.definition },
    );
    expect(data.submitConceptProposal).toMatchObject({
      name: 'Widget',
      status: 'PENDING',
      source: 'GENERATED',
      servable: false,
      concept: null,
    });
    proposalId = data.submitConceptProposal.id;
  });

  it('revises the proposal by id until it passes', async () => {
    const members = draft.definition.members as { upstream: string; documents: Record<string, string> }[];
    const definition = {
      ...draft.definition,
      members: members.map((member) =>
        member.upstream === 'warehouse'
          ? { ...member, documents: { ...member.documents, create: WAREHOUSE_CREATE } }
          : member,
      ),
    };
    const { data } = await post(
      '/graphql',
      `mutation($d: JSON!, $id: ID) { submitConceptProposal(definition: $d, id: $id, note: "location is fixed") { ${PROPOSAL_FIELDS} } }`,
      { d: definition, id: proposalId },
    );
    expect(data.submitConceptProposal).toMatchObject({
      id: proposalId,
      source: 'USER',
      servable: true,
      problems: [],
      note: 'location is fixed',
    });
  });

  it('lists proposals by status and finds one by id', async () => {
    const { data } = await post(
      '/graphql',
      `query($id: ID!) { conceptProposals(status: PENDING) { id } conceptProposal(id: $id) { status } }`,
      { id: proposalId },
    );
    expect(data.conceptProposals).toEqual([{ id: proposalId }]);
    expect(data.conceptProposal).toEqual({ status: 'PENDING' });
  });

  it('accepts the proposal as a concept, which the unified API then serves', async () => {
    const { data } = await post(
      '/graphql',
      `mutation($id: ID!) { acceptConceptProposal(id: $id) { ${PROPOSAL_FIELDS} } }`,
      {
        id: proposalId,
      },
    );
    expect(data.acceptConceptProposal).toMatchObject({
      status: 'ACCEPTED',
      concept: { name: 'Widget', servable: true },
    });
    await unified.whenIdle();
    const status = await post('/graphql', '{ unifiedStatus { state problems { message } lastError { message } } }');
    expect(status.data.unifiedStatus).toMatchObject({ state: 'READY', lastError: null });
    const served = await post('/unified/graphql', '{ concepts }');
    expect(served).toEqual({ data: { concepts: ['Widget'] } });
  });

  it('refuses to decide on a proposal twice', async () => {
    const body = await post(
      '/graphql',
      'mutation($id: ID!) { rejectConceptProposal(id: $id, reason: "late") { id } }',
      {
        id: proposalId,
      },
    );
    expect(body.errors[0].extensions.code).toBe(ErrorCode.Conflict);
  });

  it('rejects a pending proposal with a reason', async () => {
    const submitted = await post(
      '/graphql',
      'mutation { submitConceptProposal(definition: { name: "Thing" }) { id } }',
    );
    const { data } = await post(
      '/graphql',
      'mutation($id: ID!) { rejectConceptProposal(id: $id, reason: "Not shared.") { status reason } }',
      { id: submitted.data.submitConceptProposal.id },
    );
    expect(data.rejectConceptProposal).toEqual({ status: 'REJECTED', reason: 'Not shared.' });
  });
});
