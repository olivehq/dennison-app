DROP INDEX "suppliers_event_name_key";--> statement-breakpoint
ALTER TABLE "admin_invites" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_event_lower_name_key" ON "suppliers" USING btree ("event_id",lower("name"));