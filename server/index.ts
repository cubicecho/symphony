// Boot only. Preflight is the first import: it exits with a sentence when the configuration is unusable.
import './core/preflight.ts';
import { sql } from 'drizzle-orm';
import { databaseUrl, dataDir, dbConnectTimeoutMs, host, mcpKey, port, version } from './core/config.ts';
import { errorMessage } from './core/errors.ts';
import { openDatabase } from './db/client.ts';
import { waitForDatabase } from './db/wait.ts';
import { createApp, WEB_DIST } from './http/app.ts';
import { stopOnSignals } from './http/shutdown.ts';

const opened = openDatabase({ databaseUrl: databaseUrl(), dataDir: dataDir() });
if (opened.isPostgres) {
  try {
    await waitForDatabase(opened.db, { connectTimeoutMs: dbConnectTimeoutMs() });
  } catch (error) {
    console.error(`[db] cannot reach Postgres at ${opened.location}: ${errorMessage(error)}`);
    process.exit(1);
  }
}
await opened.migrate();
console.log(`[db] ${opened.isPostgres ? 'Postgres' : 'PGlite'} at ${opened.location}`);

const key = mcpKey();
const { app, unified } = createApp({
  db: opened.db,
  mcpKey: key,
  checkDatabase: () => opened.db.execute(sql`select 1`),
  dist: WEB_DIST,
});
const server = app.listen(port(), host(), () => {
  console.log(`[server] symphony ${version()} ready at http://${host()}:${port()}`);
  if (key === '') {
    console.warn('[mcp] SYMPHONY_MCP_KEY is not set, so /mcp refuses every call. Set it in .env to let agents in.');
  }
});
// The first composition runs in the background; /unified/graphql answers 503 until it succeeds.
unified.start();
stopOnSignals(server, {
  after: async () => {
    await unified.dispose();
    await opened.close();
  },
});
