CREATE TYPE "public"."email_campaign_status" AS ENUM('draft', 'sending', 'sent', 'failed');--> statement-breakpoint
ALTER TABLE "email_campaigns" ALTER COLUMN "reply_to" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN "selected_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN "status" "email_campaign_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN "recipient_count" integer;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN "test_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD COLUMN "sent_by" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "contact_type" "contact_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "entity_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "recipient_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_sent_by_admins_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_messages_event_contact_idx" ON "email_messages" USING btree ("event_id","contact_type","entity_id");--> statement-breakpoint
ALTER TABLE "email_campaigns" DROP COLUMN "selected_token_ids";