import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL ?? '';

/**
 * Migrations are generated from server/db/schema.ts into drizzle/, and committed. Generating needs no database;
 * `db:migrate` needs DATABASE_URL. An empty URL is left out, since drizzle-kit hangs on one.
 */
export default defineConfig({
  out: './drizzle',
  schema: './server/db/schema.ts',
  dialect: 'postgresql',
  ...(databaseUrl === '' ? {} : { dbCredentials: { url: databaseUrl } }),
});
