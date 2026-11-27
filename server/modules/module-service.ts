// The modules: stored with their source and their upstreams, compiled on every save. A source that fails to
// compile is kept with its errors, so an agent can fetch it back and fix it, and pages show a notice for it instead.
import { asc, eq, inArray } from 'drizzle-orm';
import { UUID_PATTERN } from '../core/consts.ts';
import { MODULE_DEFAULTS, type ModuleSettings } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import {
  type ModuleRecord,
  type ModuleService,
  ModuleStatus,
  type Upstream,
  type UpstreamService,
} from '../core/services.ts';
import type { Database } from '../db/client.ts';
import { modules, moduleUpstreams } from '../db/schema.ts';
import { loadAllowedImports } from './allowlist.ts';
import { compileModule } from './compile.ts';
import type { CompileResult, CompileUpstream } from './compile-result.ts';

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
 * @param upstreamIds - Its upstreams' ids, in order.
 * @returns The record.
 */
function toRecord(row: ModuleRow, upstreamIds: string[]): ModuleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    upstreamIds,
    source: row.source,
    compiled: row.compiled,
    status: statusOf(row.status),
    errors: row.errors,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/**
 * Reads what a compile needs from an upstream.
 *
 * @param upstream - The upstream.
 * @returns Its name and cached schema.
 */
function toCompileUpstream(upstream: Upstream): CompileUpstream {
  return { name: upstream.name, schema: upstream.schema?.schema ?? null };
}

/**
 * Builds the module service.
 *
 * @param deps - The database, the upstreams (for their names and schemas), and the import allowlist.
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
   * Finds the upstreams a module is to read.
   *
   * @param refs - Their ids or names, in order.
   * @returns The upstreams, in the same order.
   * @throws BAD_USER_INPUT for none, too many or one listed twice; NOT_FOUND for an unknown one.
   */
  const resolveUpstreams = async (refs: readonly string[]): Promise<Upstream[]> => {
    if (refs.length === 0) {
      throw badInput('A module reads at least one upstream. Name it by id or name; the first one is the default.');
    }
    if (refs.length > settings.maxUpstreams) {
      throw badInput(`A module reads at most ${settings.maxUpstreams} upstreams; this one names ${refs.length}.`);
    }
    const found: Upstream[] = [];
    for (const ref of refs) {
      const upstream = await deps.upstreams.find(ref);
      if (upstream === null) {
        throw notFound(`There is no upstream "${ref}". Call list_upstreams for their names.`);
      }
      const isListed = found.some((one) => one.id === upstream.id);
      if (isListed) {
        throw badInput(`Upstream "${upstream.name}" is listed twice. Name each of the module's upstreams once.`);
      }
      found.push(upstream);
    }
    return found;
  };

  /**
   * Compiles a source against its upstreams' cached schemas.
   *
   * @param upstreams - The module's upstreams, the default first.
   * @param source - The TSX.
   * @param fileName - Its name in stack traces.
   * @returns The compile.
   */
  const compileAgainst = async (
    upstreams: readonly CompileUpstream[],
    source: string,
    fileName: string,
  ): Promise<CompileResult> => compileModule({ source, fileName, upstreams, allowedImports: await allowedImports() });

  /**
   * Checks a source's length, finds its upstreams and compiles it.
   *
   * @param refs - The upstreams' ids or names, the default first.
   * @param source - The TSX.
   * @param fileName - Its name in stack traces.
   * @returns The upstreams' ids, in order, and the compile.
   * @throws NOT_FOUND for an unknown upstream, BAD_USER_INPUT for bad upstreams or an over-long source.
   */
  const compileFor = async (
    refs: readonly string[],
    source: string,
    fileName: string,
  ): Promise<{ upstreamIds: string[]; compile: CompileResult }> => {
    if (source.length > settings.maxSourceChars) {
      throw badInput(
        `A module's source is at most ${settings.maxSourceChars} characters; this one is ${source.length}.`,
      );
    }
    const upstreams = await resolveUpstreams(refs);
    const compile = await compileAgainst(upstreams.map(toCompileUpstream), source, fileName);
    return { upstreamIds: upstreams.map((upstream) => upstream.id), compile };
  };

  /**
   * Reads the upstream ids of some modules.
   *
   * @param moduleIds - The modules.
   * @returns Each module's upstream ids, in order.
   */
  const upstreamIdsOf = async (moduleIds: readonly string[]): Promise<Map<string, string[]>> => {
    const byModule = new Map<string, string[]>();
    if (moduleIds.length === 0) {
      return byModule;
    }
    const rows = await db
      .select()
      .from(moduleUpstreams)
      .where(inArray(moduleUpstreams.moduleId, [...moduleIds]))
      .orderBy(asc(moduleUpstreams.position));
    for (const row of rows) {
      byModule.set(row.moduleId, [...(byModule.get(row.moduleId) ?? []), row.upstreamId]);
    }
    return byModule;
  };

  /**
   * Turns rows into records, with their upstreams.
   *
   * @param rows - The module rows.
   * @returns The records, in the same order.
   */
  const toRecords = async (rows: readonly ModuleRow[]): Promise<ModuleRecord[]> => {
    const upstreamIds = await upstreamIdsOf(rows.map((row) => row.id));
    return rows.map((row) => toRecord(row, upstreamIds.get(row.id) ?? []));
  };

  return {
    list: async () => {
      const rows = await db.select().from(modules).orderBy(modules.name);
      return toRecords(rows);
    },

    find: async (id) => {
      const row = await findRow(id);
      if (row === undefined) {
        return null;
      }
      const [record] = await toRecords([row]);
      return record ?? null;
    },

    check: async (upstreams, source) => (await compileFor(upstreams, source, 'check')).compile,

    recheck: async (upstream) => {
      const found = await deps.upstreams.find(upstream);
      if (found === null) {
        return 0;
      }
      const listings = await db
        .select({ moduleId: moduleUpstreams.moduleId })
        .from(moduleUpstreams)
        .where(eq(moduleUpstreams.upstreamId, found.id));
      const moduleIds = listings.map((listing) => listing.moduleId);
      if (moduleIds.length === 0) {
        return 0;
      }
      const rows = await db.select().from(modules).where(inArray(modules.id, moduleIds));
      const upstreamIds = await upstreamIdsOf(moduleIds);
      // One lookup per upstream, however many of the modules read it. One that is gone checks as unfetched.
      const known = new Map<string, Promise<CompileUpstream>>();
      const compileUpstreamOf = (id: string): Promise<CompileUpstream> => {
        const loading =
          known.get(id) ??
          deps.upstreams.find(id).then((one) => (one === null ? { name: id, schema: null } : toCompileUpstream(one)));
        known.set(id, loading);
        return loading;
      };
      let changed = 0;
      for (const row of rows) {
        const upstreams = await Promise.all((upstreamIds.get(row.id) ?? []).map(compileUpstreamOf));
        const compile = await compileAgainst(upstreams, row.source, row.id);
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
      const { upstreamIds, compile } = await compileFor(input.upstreams, input.source, fileName);
      const values = {
        name,
        description: input.description?.trim() ?? existing?.description ?? '',
        source: input.source,
        compiled: compile.compiled,
        status: compile.ok ? ModuleStatus.Ready : ModuleStatus.Failed,
        errors: compile.errors,
      };
      const row = await db.transaction(async (tx) => {
        const [written] =
          existing === undefined
            ? await tx.insert(modules).values(values).returning()
            : await tx
                .update(modules)
                .set({ ...values, version: existing.version + 1 })
                .where(eq(modules.id, existing.id))
                .returning();
        if (written === undefined) {
          throw new Error('The module write returned no row.');
        }
        await tx.delete(moduleUpstreams).where(eq(moduleUpstreams.moduleId, written.id));
        await tx
          .insert(moduleUpstreams)
          .values(upstreamIds.map((upstreamId, position) => ({ moduleId: written.id, upstreamId, position })));
        return written;
      });
      console.log(`[modules] saved ${row.name} v${row.version}: ${row.status}`);
      return { module: toRecord(row, upstreamIds), compile };
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
