// One in-memory database per test file: opened and migrated in beforeAll, closed in afterAll.
import { IN_MEMORY, type OpenedDatabase, openPglite } from '../server/db/client.ts';

/**
 * Opens a fresh, migrated in-memory database.
 *
 * @returns The opened database; close it when the file is done.
 */
export async function openTestDatabase(): Promise<OpenedDatabase> {
  const opened = openPglite(IN_MEMORY);
  await opened.migrate();
  return opened;
}
