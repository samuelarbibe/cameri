CREATE TYPE "public"."attachment_kind" AS ENUM('trace', 'screenshot', 'video', 'log', 'other');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'passed', 'failed', 'timedOut', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."shard_status" AS ENUM('running', 'completed', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."test_status" AS ENUM('passed', 'failed', 'timedOut', 'skipped', 'interrupted');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "attachment_kind" DEFAULT 'other' NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"storage_key" text NOT NULL,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "record_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_key" text NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"expected_shards" integer DEFAULT 1 NOT NULL,
	"playwright_version" text,
	"branch" text,
	"commit_sha" text,
	"commit_message" text,
	"author" text,
	"remote_url" text,
	"ci_provider" text,
	"ci_build_id" text,
	"ci_build_url" text,
	"ci_job_name" text,
	"ci_attempt" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"stale_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"shard_index" integer NOT NULL,
	"status" "shard_status" DEFAULT 'running' NOT NULL,
	"stats" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"shard_id" uuid NOT NULL,
	"test_ref" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "test_status" NOT NULL,
	"expected_status" "test_status" DEFAULT 'passed' NOT NULL,
	"retry" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"error_message" text,
	"error_stack" text,
	"error_snippet" text,
	"error_signature" text,
	"annotations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"stdout" text,
	"stderr" text,
	"is_flaky" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"test_id" text NOT NULL,
	"title" text NOT NULL,
	"title_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file" text NOT NULL,
	"project_name" text DEFAULT '' NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_attempt_id_test_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."test_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_keys" ADD CONSTRAINT "record_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shards" ADD CONSTRAINT "shards_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_shard_id_shards_id_fk" FOREIGN KEY ("shard_id") REFERENCES "public"."shards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_test_ref_tests_id_fk" FOREIGN KEY ("test_ref") REFERENCES "public"."tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_attempt_idx" ON "attachments" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "record_keys_project_idx" ON "record_keys" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_project_run_key_idx" ON "runs" USING btree ("project_id","run_key");--> statement-breakpoint
CREATE INDEX "runs_project_created_idx" ON "runs" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_branch_idx" ON "runs" USING btree ("project_id","branch");--> statement-breakpoint
CREATE INDEX "runs_incomplete_idx" ON "runs" USING btree ("stale_at") WHERE "runs"."completed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "shards_run_index_idx" ON "shards" USING btree ("run_id","shard_index");--> statement-breakpoint
CREATE INDEX "attempts_run_idx" ON "test_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "attempts_test_history_idx" ON "test_attempts" USING btree ("test_ref","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attempts_signature_idx" ON "test_attempts" USING btree ("project_id","error_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_run_test_retry_idx" ON "test_attempts" USING btree ("run_id","test_ref","retry");--> statement-breakpoint
CREATE UNIQUE INDEX "tests_project_test_idx" ON "tests" USING btree ("project_id","test_id");--> statement-breakpoint
CREATE INDEX "tests_project_file_idx" ON "tests" USING btree ("project_id","file");