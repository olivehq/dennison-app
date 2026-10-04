-- Existing databases may already hold duplicates the new partial unique
-- indexes forbid. Keep the newest row live and retire the rest.
UPDATE "access_tokens" AS t SET "revoked_at" = now() WHERE t."revoked_at" IS NULL AND EXISTS (SELECT 1 FROM "access_tokens" AS n WHERE n."contact_type" = t."contact_type" AND n."entity_id" = t."entity_id" AND n."revoked_at" IS NULL AND (n."created_at" > t."created_at" OR (n."created_at" = t."created_at" AND n."id" > t."id")));--> statement-breakpoint
UPDATE "match_runs" AS r SET "is_active" = false WHERE r."is_active" AND EXISTS (SELECT 1 FROM "match_runs" AS n WHERE n."event_id" = r."event_id" AND n."is_active" AND (n."created_at" > r."created_at" OR (n."created_at" = r."created_at" AND n."id" > r."id")));--> statement-breakpoint
ALTER TABLE "name_aliases" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "name_aliases" ADD COLUMN "canonical_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "access_tokens_contact_live_key" ON "access_tokens" USING btree ("contact_type","entity_id") WHERE "access_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "match_runs_event_active_key" ON "match_runs" USING btree ("event_id") WHERE "match_runs"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "name_aliases_global_type_raw_key" ON "name_aliases" USING btree ("entity_type",lower("raw_text")) WHERE "name_aliases"."event_id" is null;