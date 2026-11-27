// The migration that gave modules several upstreams keeps every existing module's one upstream as its default.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The committed migrations. */
const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
/** The migration under test: everything before it is applied first, then rows are written, then the rest. */
const MIGRATION = '20261127183334_modules_with_many_upstreams';
const UPSTREAM_ID = '7b0c1d2e-3f40-4a51-8b62-9c7d8e9fa0b1';
const UNIFIED_ID = '00000000-0000-4000-8000-000000000001';

let client: PGlite;
let earlier = '';

beforeAll(async () => {
  earlier = await mkdtemp(path.join(tmpdir(), 'symphony-migrations-'));
  const folders = (await readdir(MIGRATIONS)).filter((name) => name < MIGRATION);
  await Promise.all(
    folders.map((name) => cp(path.join(MIGRATIONS, name), path.join(earlier, name), { recursive: true })),
  );
  client = new PGlite();
});
afterAll(async () => {
  await client.close();
  await rm(earlier, { recursive: true, force: true });
});

describe('the module_upstreams migration', () => {
  it('moves each module upstream into module_upstreams at position 0 and drops the column', async () => {
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: earlier });
    await db.execute(
      sql`insert into upstreams (id, name, url) values (${UPSTREAM_ID}, 'shop', 'http://x.test/graphql')`,
    );
    await db.execute(sql`
      insert into modules (name, upstream_id, source, status) values
        ('Orders', ${UPSTREAM_ID}, 'x', 'READY'),
        ('Notes', ${UNIFIED_ID}, 'y', 'FAILED')
    `);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const listed = await db.execute<{ name: string; upstream_id: string; position: number }>(sql`
      select m.name, mu.upstream_id, mu.position
      from module_upstreams mu join modules m on m.id = mu.module_id
      order by m.name
    `);
    expect(listed.rows).toEqual([
      { name: 'Notes', upstream_id: UNIFIED_ID, position: 0 },
      { name: 'Orders', upstream_id: UPSTREAM_ID, position: 0 },
    ]);
    const columns = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'modules'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('upstream_id');
  });
});
