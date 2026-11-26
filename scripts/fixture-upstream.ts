// Serves the test fixture API on a port, for trying Symphony by hand: `npm run fixture:upstream`.
// Register it in Symphony as http://localhost:4100/graphql (or FIXTURE_PORT).
import { createServer } from 'node:http';
import { createFixtureUpstream } from '../tests/fixtures/upstream.ts';

const DEFAULT_PORT = 4100;
const port = Number(process.env.FIXTURE_PORT ?? DEFAULT_PORT);
const token = process.env.FIXTURE_TOKEN;
const server = createServer(createFixtureUpstream({ token }));
server.listen(port, () => {
  const auth = token === undefined ? 'no auth' : 'Bearer token required';
  console.log(`[fixture] upstream at http://localhost:${port}/graphql (${auth})`);
});
