CREATE TYPE "public"."integration_provider" AS ENUM('gitlab');--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"base_url" text,
	"token_cipher" text NOT NULL,
	"token_hint" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mr_provider" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mr_project_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mr_iid" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mr_server_url" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mr_url" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mr_note_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mr_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_project_provider_idx" ON "integrations" USING btree ("project_id","provider");