// Symphony's tables: the upstream APIs it wraps and their cached schemas, the modules written against
// them, the pages modules are placed on, and the concepts and wiring the unified gateway is composed from.
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { WiringOverride } from '../gateway/wiring.ts';

/** One header sent with every request to an upstream. The value may hold `${env:NAME}` references. */
export interface StoredHeader {
  name: string;
  value: string;
}

/** One problem a module's compile found, kept with the module. */
export interface StoredCompileError {
  stage: string;
  message: string;
  line: number | null;
  column: number | null;
}

/** A GraphQL API Symphony wraps. */
export const upstreams = pgTable('upstreams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  url: text('url').notNull(),
  headers: jsonb('headers').$type<StoredHeader[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The last introspection of an upstream. One row per upstream, replaced on refresh. */
export const upstreamSchemas = pgTable('upstream_schemas', {
  upstreamId: uuid('upstream_id')
    .primaryKey()
    .references(() => upstreams.id, { onDelete: 'cascade' }),
  /** The raw introspection result (`__schema` and below), from which the schema is rebuilt. */
  introspection: jsonb('introspection').notNull(),
  /** The same schema printed as SDL, which is what agents read. */
  sdl: text('sdl').notNull(),
  /** sha256 of the SDL, so a refresh can tell whether anything changed. */
  hash: text('hash').notNull(),
  typeCount: integer('type_count').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A UI module: one TSX file bound to one upstream, and what its last compile made of it. */
export const modules = pgTable(
  'modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /**
     * The upstream's id. No foreign key: the built-in unified upstream has no row. Removing an upstream deletes its
     * modules in the same transaction (upstreams/upstream-service.ts).
     */
    upstreamId: uuid('upstream_id').notNull(),
    source: text('source').notNull(),
    /** The compiled browser code, or null while the source does not compile. */
    compiled: text('compiled'),
    /** `READY` when `compiled` matches `source`, `FAILED` when the last compile found errors. */
    status: text('status').notNull(),
    errors: jsonb('errors').$type<StoredCompileError[]>().notNull().default(sql`'[]'::jsonb`),
    /** Goes up by one on every save, so the browser's copy of the code can be cached by version. */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('ix_modules_upstream').on(table.upstreamId),
    check('ck_modules_status', sql`${table.status} in ('READY', 'FAILED')`),
  ],
);

/**
 * A concept: one entity read and written across its member upstreams. The definition is kept as submitted,
 * so a concept an upstream's schema change has broken stays visible with its problems.
 */
export const concepts = pgTable('concepts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  definition: jsonb('definition').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * A user's edit to one source's wiring, keyed by the source's name: an upstream's, or the concept subgraph's.
 * It follows its upstream through a rename and goes when the upstream is removed (gateway/wiring-service.ts).
 */
export const wiringOverrides = pgTable('wiring_overrides', {
  source: text('source').primaryKey(),
  override: jsonb('override').$type<WiringOverride>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** A page of modules. */
export const pages = pgTable('pages', {
  slug: text('slug').primaryKey(),
  title: text('title').notNull(),
  position: integer('position').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A module placed on a page. */
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageSlug: text('page_slug')
      .notNull()
      .references(() => pages.slug, { onDelete: 'cascade' }),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    columnSpan: integer('column_span').notNull(),
    fullWidth: boolean('full_width').notNull().default(false),
  },
  (table) => [index('ix_items_page').on(table.pageSlug), check('ck_items_column_span', sql`${table.columnSpan} >= 1`)],
);
