ALTER TABLE "upstreams" ADD COLUMN "discovered_key" text;--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_discovered_key_key" UNIQUE("discovered_key");