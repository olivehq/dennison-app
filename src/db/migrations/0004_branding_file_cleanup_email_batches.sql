CREATE TABLE "pending_file_deletions" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "batch_key" uuid;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "request" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "branding" jsonb;--> statement-breakpoint
CREATE INDEX "pending_file_deletions_next_attempt_idx" ON "pending_file_deletions" USING btree ("next_attempt_at");