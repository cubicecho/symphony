// The modules: stored with their source, compiled on every save. A source that fails to compile is kept
// with its errors, so an agent can fetch it back and fix it, and pages show a notice for it instead.
import { eq } from 'drizzle-orm';
import { UUID_PATTERN } from '../core/consts.ts';
import { MODULE_DEFAULTS, type ModuleSettings } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { type ModuleRecord, type ModuleService, ModuleStatus, type UpstreamService } from '../core/services.ts';
import type { Database } from '../db/client.ts';
import { modules } from '../db/schema.ts';
import { loadAllowedImports } from './allowlist.ts';
import { compileModule } from './compile.ts';
import type { CompileResult } from './compile-result.ts';

/** What the service talks to. */
export interface ModuleServiceDeps {
  db: Database;
  upstreams: UpstreamService;
  /** The specifiers modules may import. Default: read from web/src/components once, on first use. */
  allowedImports?: () => Promise<ReadonlySet<string>>;
}

type ModuleRow = typeof modules.$inferSelect;

/**
 * Narrows a stored status to the vocabulary.
 *
 * @param status - The column's text.
 * @returns The status; anything unknown reads as FAILED.
 */
function statusOf(status: string): ModuleStatus {
  return status === ModuleStatus.Ready ? ModuleStatus.Ready : ModuleStatus.Failed;
}

/**
 * Turns a row into a record.
 *
 * @param row - The row.
 * @returns The record.
 */
function toRecord(row: ModuleRow): ModuleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    upstreamId: row.upstreamId,
    source: row.source,
    compiled: row.compiled,
    status: statusOf(row.status),
    errors: row.errors,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/**
 * Builds the module service.
 *
 * @param deps - The database, the upstreams (for their schemas), and the import allowlist.
 * @param [overrides] - Module settings to replace.
 * @returns The service.
 */
export function createModuleService(deps: ModuleServiceDeps, overrides: Partial<ModuleSettings> = {}): ModuleService {
  const settings = { ...MODULE_DEFAULTS, ...overrides };
  const { db } = deps;
  let allowed: Promise<ReadonlySet<string>> | null = null;
  const allowedImports = (): Promise<ReadonlySet<string>> => {
    const loading = allowed ?? deps.allowedImports?.() ?? loadAllowedImports();
    allowed = loading;
    return loading;
  };

  /**
   * Compiles a source against an upstream's cached schema.
   *
   * @param upstream - The upstream's id or name.
   * @param source - The TSX.
   * @param fileName - Its name in stack traces.
   * @returns The upstream's id and the compile.
   * @throws NOT_FOUND for an unknown upstream, BAD_USER_INPUT for an over-long source.
   */
  const compileFor = async (
    upstream: string,
    source: string,
    fileName: string,
  ): Promise<{ upstreamId: string; compile: CompileResult }> => {
    if (source.length > settings.maxSourceChars) {
      throw badInput(
        `A module's source is at most ${settings.maxSourceChars} characters; this one is ${source.length}.`,
      );
    }
    const found = await deps.upstreams.find(upstream);
    if (found === null) {
      throw notFound(`There is no upstream "${upstream}". Call list_upstreams for their names.`);
    }
    const compile = await compileModule({
      source,
      fileName,
      schema: found.schema?.schema ?? null,
      allowedImports: await allowedImports(),
    });
    return { upstreamId: found.id, compile };
  };

  return {
    list: async () => {
      const rows = await db.select().from(modules).orderBy(modules.name);
      return rows.map(toRecord);
    },

    find: async (id) => {
      const row = await findRow(id);
      return row === undefined ? null : toRecord(row);
    },

    check: async (upstream, source) => (await compileFor(upstream, source, 'check')).compile,

    recheck: async (upstream) => {
      const found = await deps.upstreams.find(upstream);
      if (found === null) {
        return 0;
      }
      const rows = await db.select().from(modules).where(eq(modules.upstreamId, found.id));
      let changed = 0;
      for (const row of rows) {
        const compile = await compileModule({
          source: row.source,
          fileName: row.id,
          schema: found.schema?.schema ?? null,
          allowedImports: await allowedImports(),
        });
        const status = compile.ok ? ModuleStatus.Ready : ModuleStatus.Failed;
        const isSame = status === row.status && JSON.stringify(compile.errors) === JSON.stringify(row.errors);
        if (isSame) {
          continue;
        }
        await db
          .update(modules)
          .set({ compiled: compile.compiled, status, errors: compile.errors, version: row.version + 1 })
          .where(eq(modules.id, row.id));
        console.log(`[modules] rechecked ${row.name} against ${found.name}: ${status}`);
        changed += 1;
      }
      return changed;
    },

    save: async (input) => {
      const name = input.name.trim();
      const isNameValid = name !== '' && name.length <= settings.maxNameChars;
      if (isNameValid === false) {
        throw badInput(`A module's name is 1–${settings.maxNameChars} characters.`);
      }
      const existing = input.id === undefined ? undefined : await findRow(input.id);
      if (input.id !== undefined && existing === undefined) {
        throw notFound(`There is no module ${input.id}. Leave id out to create a new one.`);
      }
      const fileName = existing?.id ?? name.replace(/[^A-Za-z0-9_-]+/g, '-');
      const { upstreamId, compile } = await compileFor(input.upstream, input.source, fileName);
      const values = {
        name,
        description: input.description?.trim() ?? existing?.description ?? '',
        upstreamId,
        source: input.source,
        compiled: compile.compiled,
        status: compile.ok ? ModuleStatus.Ready : ModuleStatus.Failed,
        errors: compile.errors,
      };
      const [row] =
        existing === undefined
          ? await db.insert(modules).values(values).returning()
          : await db
              .update(modules)
              .set({ ...values, version: existing.version + 1 })
              .where(eq(modules.id, existing.id))
              .returning();
      if (row === undefined) {
        throw new Error('The module write returned no row.');
      }
      console.log(`[modules] saved ${row.name} v${row.version}: ${row.status}`);
      return { module: toRecord(row), compile };
    },

    remove: async (id) => {
      const row = await findRow(id);
      if (row === undefined) {
        return false;
      }
      await db.delete(modules).where(eq(modules.id, row.id));
      return true;
    },
  };

  /**
   * Finds a module row.
   *
   * @param id - Its id; anything that is not a UUID finds nothing.
   * @returns The row, or undefined.
   */
  async function findRow(id: string): Promise<ModuleRow | undefined> {
    const isId = UUID_PATTERN.test(id);
    if (isId === false) {
      return undefined;
    }
    const [row] = await db.select().from(modules).where(eq(modules.id, id));
    return row;
  }
}
