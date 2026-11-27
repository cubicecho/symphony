// The proposal service on PGlite, over the fixture upstreams: proposing, submitting and revising, and a person's
// accept or reject.
import { ErrorCode } from '../../server/core/errors.ts';
import {
  type ConceptProposalService,
  type ConceptService,
  ProposalSource,
  ProposalStatus,
  type UpstreamService,
} from '../../server/core/services.ts';
import type { OpenedDatabase } from '../../server/db/client.ts';
import { createConceptService } from '../../server/gateway/concept-service.ts';
import { createProposalService } from '../../server/gateway/proposal-service.ts';
import { createUpstreamService } from '../../server/upstreams/upstream-service.ts';
import { openTestDatabase } from '../db.ts';
import {
  createProposalUpstreams,
  PROPOSAL_SDLS,
  proposalUpstreamUrl,
  WAREHOUSE_CREATE,
} from '../fixtures/proposal-upstreams.ts';

let opened: OpenedDatabase;
let upstreams: UpstreamService;
let concepts: ConceptService;
let proposals: ConceptProposalService;

beforeAll(async () => {
  opened = await openTestDatabase();
  upstreams = createUpstreamService({ db: opened.db, fetch: createProposalUpstreams().fetch });
  concepts = createConceptService({ db: opened.db, upstreams });
  proposals = createProposalService({ db: opened.db, upstreams, concepts });
  for (const [name] of PROPOSAL_SDLS) {
    await upstreams.add({ name, url: proposalUpstreamUrl(name), headers: [] });
  }
  await upstreams.add({ name: 'offline', url: 'http://offline.test/graphql', headers: [] });
});
afterAll(() => opened.close());

/**
 * Proposes the Widget concept and fills in the create the proposer left out.
 *
 * @returns The completed definition.
 */
async function completedWidget(): Promise<Record<string, unknown>> {
  const { drafts } = await proposals.propose();
  const [draft] = drafts;
  if (draft === undefined) {
    throw new Error('Nothing was proposed.');
  }
  const [catalog, warehouse] = draft.definition.members;
  return {
    ...draft.definition,
    members: [catalog, { ...warehouse, documents: { ...warehouse?.documents, create: WAREHOUSE_CREATE } }],
  };
}

describe('concept proposals', () => {
  it('proposes from every cached upstream, with the validator problems of each draft', async () => {
    const { drafts, notReady } = await proposals.propose();
    expect(drafts.map((draft) => draft.definition.name)).toEqual(['Widget']);
    expect(drafts[0]?.problems).toContainEqual(
      expect.objectContaining({ concept: 'Widget', message: expect.stringMatching(/^members\.1\.documents\.create/) }),
    );
    expect(notReady.map((candidate) => candidate.name)).toEqual(['Gizmo']);
  });

  it('proposes from named upstreams only, and refuses names it cannot use', async () => {
    expect((await proposals.propose(['catalog', 'storefront'])).drafts).toEqual([]);
    await expect(proposals.propose(['nowhere'])).rejects.toMatchObject({ extensions: { code: ErrorCode.NotFound } });
    await expect(proposals.propose(['offline'])).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
  });

  it('stores a submit with its problems, then revises it by id until it passes', async () => {
    const { drafts } = await proposals.propose();
    const first = await proposals.submit({ definition: drafts[0]?.definition, source: ProposalSource.Generated });
    expect(first).toMatchObject({ name: 'Widget', status: ProposalStatus.Pending, source: ProposalSource.Generated });
    expect(first.problems.length).toBeGreaterThan(0);
    const revised = await proposals.submit({
      id: first.id,
      definition: await completedWidget(),
      source: ProposalSource.Agent,
      note: 'location is always "main".',
    });
    expect(revised).toMatchObject({
      id: first.id,
      problems: [],
      source: ProposalSource.Agent,
      note: 'location is always "main".',
    });
    expect((await proposals.find(first.id))?.problems).toEqual([]);
  });

  it('accepts a pending proposal as a concept, and then refuses to change it', async () => {
    const [pending] = await proposals.list(ProposalStatus.Pending);
    if (pending === undefined) {
      throw new Error('No pending proposal.');
    }
    const accepted = await proposals.accept(pending.id);
    expect(accepted.status).toBe(ProposalStatus.Accepted);
    const concept = await concepts.find('Widget');
    expect(concept?.problems).toEqual([]);
    expect(accepted.conceptId).toBe(concept?.id);
    await expect(proposals.accept(pending.id)).rejects.toMatchObject({ extensions: { code: ErrorCode.Conflict } });
    await expect(
      proposals.submit({ id: pending.id, definition: {}, source: ProposalSource.Agent }),
    ).rejects.toMatchObject({ extensions: { code: ErrorCode.Conflict } });
  });

  it('keeps the problems of a refused accept, and leaves the proposal pending', async () => {
    const broken = await proposals.submit({ definition: { name: 'Broken' }, source: ProposalSource.User });
    await expect(proposals.accept(broken.id)).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput, problems: expect.any(Array) },
    });
    expect((await proposals.find(broken.id))?.status).toBe(ProposalStatus.Pending);
  });

  it('rejects with a reason, and lists by status', async () => {
    const pending = await proposals.list(ProposalStatus.Pending);
    const [broken] = pending;
    if (broken === undefined) {
      throw new Error('No pending proposal.');
    }
    const rejected = await proposals.reject(broken.id, 'Not an entity.');
    expect(rejected).toMatchObject({ status: ProposalStatus.Rejected, reason: 'Not an entity.' });
    expect(await proposals.list(ProposalStatus.Pending)).toEqual([]);
    expect((await proposals.list()).map((one) => one.status).sort()).toEqual([
      ProposalStatus.Accepted,
      ProposalStatus.Rejected,
    ]);
  });

  it('finds nothing for an unknown id', async () => {
    expect(await proposals.find('not-a-uuid')).toBeNull();
    await expect(proposals.reject('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      extensions: { code: ErrorCode.NotFound },
    });
  });
});
