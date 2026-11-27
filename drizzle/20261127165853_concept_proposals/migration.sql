CREATE TABLE "concept_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"problems" jsonb DEFAULT '[]' NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"reason" text,
	"concept_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_concept_proposals_status" CHECK ("status" in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "ck_concept_proposals_source" CHECK ("source" in ('generated', 'agent', 'user'))
);
--> statement-breakpoint
CREATE INDEX "ix_concept_proposals_status" ON "concept_proposals" ("status");--> statement-breakpoint
ALTER TABLE "concept_proposals" ADD CONSTRAINT "concept_proposals_concept_id_concepts_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "concepts"("id") ON DELETE SET NULL;