ALTER TABLE "runs" ADD COLUMN "mr_title" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mr_target_branch" text;--> statement-breakpoint
CREATE INDEX "runs_mr_idx" ON "runs" USING btree ("project_id","mr_iid","created_at" DESC NULLS LAST) WHERE "runs"."mr_iid" is not null;