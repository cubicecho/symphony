CREATE TABLE "module_upstreams" (
	"module_id" uuid,
	"upstream_id" uuid,
	"position" integer NOT NULL,
	CONSTRAINT "module_upstreams_pkey" PRIMARY KEY("module_id","upstream_id")
);
--> statement-breakpoint
-- Hand-added: every existing module keeps its one upstream, as its default (position 0).
INSERT INTO "module_upstreams" ("module_id", "upstream_id", "position") SELECT "id", "upstream_id", 0 FROM "modules";--> statement-breakpoint
DROP INDEX "ix_modules_upstream";--> statement-breakpoint
ALTER TABLE "modules" DROP COLUMN "upstream_id";--> statement-breakpoint
CREATE INDEX "ix_module_upstreams_upstream" ON "module_upstreams" ("upstream_id");--> statement-breakpoint
ALTER TABLE "module_upstreams" ADD CONSTRAINT "module_upstreams_module_id_modules_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE;