CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"page_slug" text NOT NULL,
	"module_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"column_span" integer NOT NULL,
	"full_width" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ck_items_column_span" CHECK ("column_span" >= 1)
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"upstream_id" uuid NOT NULL,
	"source" text NOT NULL,
	"compiled" text,
	"status" text NOT NULL,
	"errors" jsonb DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_modules_status" CHECK ("status" in ('READY', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"slug" text PRIMARY KEY,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_schemas" (
	"upstream_id" uuid PRIMARY KEY,
	"introspection" jsonb NOT NULL,
	"sdl" text NOT NULL,
	"hash" text NOT NULL,
	"type_count" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL UNIQUE,
	"url" text NOT NULL,
	"headers" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_items_page" ON "items" ("page_slug");--> statement-breakpoint
CREATE INDEX "ix_modules_upstream" ON "modules" ("upstream_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_page_slug_pages_slug_fkey" FOREIGN KEY ("page_slug") REFERENCES "pages"("slug") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_module_id_modules_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_upstream_id_upstreams_id_fkey" FOREIGN KEY ("upstream_id") REFERENCES "upstreams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "upstream_schemas" ADD CONSTRAINT "upstream_schemas_upstream_id_upstreams_id_fkey" FOREIGN KEY ("upstream_id") REFERENCES "upstreams"("id") ON DELETE CASCADE;