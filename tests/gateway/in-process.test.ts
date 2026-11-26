// Question 4: a subgraph that is an in-memory GraphQLSchema, executed in-process with no HTTP route.
import { composeSupergraph } from '../../server/gateway/compose.ts';
import { createUnifiedGateway, type UnifiedGateway } from '../../server/gateway/gateway.ts';
import { createPresenceFixture, type PresenceFixture } from '../fixtures/presence-schema.ts';
import {
  createUnifiedFixtures,
  DIRECTORY_SOURCE,
  postGraphQL,
  type UnifiedFixtures,
} from '../fixtures/unified-sources.ts';

let fixtures: UnifiedFixtures;
let presence: PresenceFixture;
let gateway: UnifiedGateway;

beforeAll(async () => {
  fixtures = createUnifiedFixtures();
  presence = createPresenceFixture();
  const supergraph = await composeSupergraph([DIRECTORY_SOURCE, presence.source], { fetch: fixtures.fetch });
  gateway = createUnifiedGateway({ supergraph, fetch: fixtures.fetch });
});
afterAll(() => gateway.dispose());

describe('an in-process schema source', () => {
  it('adds its field to the merged Team', async () => {
    const body = await postGraphQL(gateway.runtime, '{ team(slug: "a") { name presence } }');
    expect(body.errors).toBeUndefined();
    expect(body.data?.team).toEqual({ name: 'Team A', presence: 'online' });
  });

  it('routes its mutation to the schema, without a request to any network source', async () => {
    const requestsBefore = fixtures.directory.requestHeaders.length;
    const body = await postGraphQL(
      gateway.runtime,
      'mutation { setPresence(slug: "b", presence: "away") { slug presence } }',
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.setPresence).toEqual({ slug: 'b', presence: 'away' });
    expect(presence.mutations).toEqual(['b']);
    expect(fixtures.directory.requestHeaders.length).toBe(requestsBefore);
  });

  it('merges network fields into the mutation result', async () => {
    const body = await postGraphQL(
      gateway.runtime,
      'mutation { setPresence(slug: "a", presence: "busy") { name presence } }',
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.setPresence).toEqual({ name: 'Team A', presence: 'busy' });
  });
});
