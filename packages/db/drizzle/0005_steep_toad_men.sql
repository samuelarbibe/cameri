CREATE TYPE "public"."plan_strategy" AS ENUM('history', 'even');--> statement-breakpoint
CREATE TABLE "run_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_key" text NOT NULL,
	"shard_count" integer NOT NULL,
	"spec_count" integer NOT NULL,
	"spec_digest" text NOT NULL,
	"strategy" "plan_strategy" NOT NULL,
	"assignments" jsonb NOT NULL,
	"estimated_ms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_plans_project_run_key_idx" ON "run_plans" USING btree ("project_id","run_key");