// propose_concepts and submit_concept through the SDK's client, over the fake services and the proposal fixtures.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Upstream } from '../../server/core/services.ts';
import { createSymphonyMcpServer } from '../../server/mcp/server.ts';
import { cachedUpstream } from '../fixtures/memo-upstream.ts';
import { PROPOSAL_SDLS, WAREHOUSE_CREATE } from '../fixtures/proposal-upstreams.ts';
import { createFakeServices } from './fake-services.ts';

let client: Client;

beforeAll(async () => {
  const upstreams: Upstream[] = PROPOSAL_SDLS.map(([name, sdl]) => cachedUpstream(name, sdl));
  const { services } = createFakeServices(undefined, upstreams);
  const server = createSymphonyMcpServer(services, '9.9.9');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
});
afterAll(() => client.close());

/**
 * Calls a tool and reads its answer as JSON.
 *
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns Whether it failed, and its text parsed as JSON when it is JSON.
 */
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[])[0]?.text ?? '';
  return { isError: result.isError === true, text, json: result.isError === true ? null : JSON.parse(text) };
}

describe('the proposal tools', () => {
  it('lists propose_concepts and submit_concept', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['propose_concepts', 'submit_concept']));
  });

  it('drafts concepts with reasons and validator problems, limited to named upstreams', async () => {
    const all = await call('propose_concepts', {});
    const [draft] = all.json.drafts;
    expect(draft.definition.name).toBe('Widget');
    expect(draft.reasons.length).toBeGreaterThan(0);
    expect(draft.problems.length).toBeGreaterThan(0);
    expect(all.json.notReady[0].name).toBe('Gizmo');
    const narrowed = await call('propose_concepts', { upstreams: ['catalog'] });
    expect(narrowed.json).toEqual({ drafts: [], notReady: [] });
  });

  it('stores a submit with its problems, and passes once resubmitted with the same id', async () => {
    const { json } = await call('propose_concepts', {});
    const definition = json.drafts[0].definition;
    const first = await call('submit_concept', { definition, source: 'generated' });
    expect(first.json).toMatchObject({ name: 'Widget', status: 'pending', ok: false });
    expect(first.json.next).toContain(`id "${first.json.id}"`);
    const [catalog, warehouse] = definition.members;
    const completed = {
      ...definition,
      members: [catalog, { ...warehouse, documents: { ...warehouse.documents, create: WAREHOUSE_CREATE } }],
    };
    const second = await call('submit_concept', { definition: completed, id: first.json.id, note: 'filled in create' });
    expect(second.json).toMatchObject({ id: first.json.id, ok: true, problems: [] });
    expect(second.json.next).toMatch(/A person accepts or rejects it/);
  });

  it('answers an unknown id as an error', async () => {
    const result = await call('submit_concept', { definition: { name: 'X' }, id: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no concept proposal nope/);
  });
});
