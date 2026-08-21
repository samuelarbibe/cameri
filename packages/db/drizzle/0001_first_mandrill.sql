ALTER TABLE "test_attempts" ADD COLUMN "parallel_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD COLUMN "worker_index" integer DEFAULT 0 NOT NULL;