import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { EventSettings } from "../lib/schemas/event-settings";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Better Auth tables. Property keys are the field names Better Auth expects;
// SQL names are ours. The `admins` table is Better Auth's `user` model.
// ---------------------------------------------------------------------------

export const admins = pgTable("admins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  disabledAt: timestamptz("disabled_at"),
  invitedBy: text("invited_by"),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamptz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("accounts_user_id_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

// Better Auth's database-backed rate limiter. Memory storage resets on every
// serverless cold start, so the counters live here instead.
export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const adminInvites = pgTable(
  "admin_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => admins.id),
    expiresAt: timestamptz("expires_at").notNull(),
    acceptedAt: timestamptz("accepted_at"),
    createdAt: createdAt(),
  },
  (table) => [index("admin_invites_email_idx").on(table.email)],
);

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const eventStatusEnum = pgEnum("event_status", [
  "draft",
  "imported",
  "matched",
  "locked",
  "sent",
  "archived",
]);
export const rosterStatusEnum = pgEnum("roster_status", ["active", "withdrawn"]);
export const supplierTypeEnum = pgEnum("supplier_type", ["business", "hotel"]);
export const partyTypeEnum = pgEnum("party_type", ["buyer", "supplier"]);
export const aliasSourceEnum = pgEnum("alias_source", ["auto", "manual"]);
export const importKindEnum = pgEnum("import_kind", [
  "participants",
  "suppliers",
  "buyer_biztech_rankings",
  "buyer_hotel_rankings",
  "supplier_rankings",
]);
export const importStatusEnum = pgEnum("import_status", [
  "uploaded",
  "validated",
  "applied",
  "failed",
]);
export const matchRunStatusEnum = pgEnum("match_run_status", ["running", "completed", "failed"]);
export const appointmentSourceEnum = pgEnum("appointment_source", ["engine", "manual"]);
export const contactTypeEnum = pgEnum("contact_type", [
  "buyer",
  "supplier_admin",
  "supplier_attendee",
]);
export const emailAudienceEnum = pgEnum("email_audience", [
  "all",
  "buyers",
  "suppliers",
  "selected",
  "changed_since_last_send",
]);
export const emailCampaignKindEnum = pgEnum("email_campaign_kind", [
  "initial",
  "reminder",
  "update",
]);
export const emailMessageStatusEnum = pgEnum("email_message_status", [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
]);
export const emailCampaignStatusEnum = pgEnum("email_campaign_status", [
  "draft",
  "sending",
  "sent",
  "failed",
]);

// ---------------------------------------------------------------------------
// Domain tables. Everything hangs off an event and cascades with it.
// ---------------------------------------------------------------------------

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  eventDate: date("event_date", { mode: "string" }).notNull(),
  timezone: text("timezone").notNull(),
  status: eventStatusEnum("status").notNull().default("draft"),
  // Per-event tunables, validated by eventSettingsSchema on every write (D19).
  settings: jsonb("settings").$type<EventSettings>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    organization: text("organization"),
    title: text("title"),
    displayName: text("display_name"),
    biztechOptIn: boolean("biztech_opt_in").notNull().default(false),
    status: rosterStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("participants_event_email_key").on(table.eventId, table.email),
    index("participants_event_status_idx").on(table.eventId, table.status),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: supplierTypeEnum("type").notNull(),
    deskNumber: integer("desk_number"),
    deskOverride: boolean("desk_override").notNull().default(false),
    adminContactName: text("admin_contact_name"),
    adminContactEmail: text("admin_contact_email"),
    attendeeContactName: text("attendee_contact_name"),
    attendeeContactEmail: text("attendee_contact_email"),
    status: rosterStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("suppliers_event_name_key").on(table.eventId, table.name),
    index("suppliers_event_status_idx").on(table.eventId, table.status),
  ],
);

export const nameAliases = pgTable(
  "name_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    rawText: text("raw_text").notNull(),
    entityType: partyTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    source: aliasSourceEnum("source").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("name_aliases_event_type_raw_key").on(
      table.eventId,
      table.entityType,
      table.rawText,
    ),
  ],
);

export type ImportValidation = {
  errors: { row: number | null; message: string }[];
  warnings: { row: number | null; message: string }[];
  unresolvedNames: string[];
};

export const imports = pgTable(
  "imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    kind: importKindEnum("kind").notNull(),
    fileKey: text("file_key").notNull(),
    fileName: text("file_name").notNull(),
    status: importStatusEnum("status").notNull().default("uploaded"),
    validation: jsonb("validation").$type<ImportValidation>(),
    rowCount: integer("row_count"),
    createdBy: text("created_by").references(() => admins.id),
    createdAt: createdAt(),
    appliedAt: timestamptz("applied_at"),
  },
  (table) => [index("imports_event_kind_idx").on(table.eventId, table.kind)],
);

export const rankings = pgTable(
  "rankings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    rankerType: partyTypeEnum("ranker_type").notNull(),
    rankerId: uuid("ranker_id").notNull(),
    targetType: partyTypeEnum("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    rank: integer("rank"),
    isRejection: boolean("is_rejection").notNull().default(false),
    importId: uuid("import_id").references(() => imports.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("rankings_pair_key").on(
      table.eventId,
      table.rankerType,
      table.rankerId,
      table.targetType,
      table.targetId,
    ),
    index("rankings_event_ranker_idx").on(table.eventId, table.rankerType, table.rankerId),
  ],
);

export const matchRuns = pgTable(
  "match_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: matchRunStatusEnum("status").notNull().default("running"),
    settingsSnapshot: jsonb("settings_snapshot").$type<EventSettings>().notNull(),
    // Shape owned by the engine (QualityStats). Stored as written, read as unknown.
    stats: jsonb("stats").$type<Record<string, unknown>>(),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    durationMs: integer("duration_ms"),
    isActive: boolean("is_active").notNull().default(false),
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => matchRuns.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").references(() => admins.id),
    createdAt: createdAt(),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [index("match_runs_event_idx").on(table.eventId, table.createdAt)],
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => matchRuns.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    slot: integer("slot").notNull(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    buyerRank: integer("buyer_rank"),
    supplierRank: integer("supplier_rank"),
    source: appointmentSourceEnum("source").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    // The three hard rules. The database is the authority; code checks them
    // too for friendlier errors.
    uniqueIndex("appointments_run_slot_buyer_key").on(table.runId, table.slot, table.buyerId),
    uniqueIndex("appointments_run_slot_supplier_key").on(
      table.runId,
      table.slot,
      table.supplierId,
    ),
    uniqueIndex("appointments_run_pair_key").on(table.runId, table.buyerId, table.supplierId),
    index("appointments_run_idx").on(table.runId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null for admin and team changes, which belong to no event.
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    // Null for system actions such as the retention cron.
    adminId: text("admin_id").references(() => admins.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
    note: text("note"),
    // clock_timestamp() instead of now(): rows written in one transaction
    // must still order by insertion time in the activity log.
    createdAt: timestamptz("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index("audit_events_event_created_idx").on(table.eventId, table.createdAt),
    index("audit_events_entity_idx").on(table.entityType, table.entityId),
  ],
);

export const accessTokens = pgTable(
  "access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    contactType: contactTypeEnum("contact_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    // The plain token, AES-256-GCM encrypted with a key derived from
    // TOKEN_PEPPER (D59), so emails and the access list can reuse a link
    // instead of rotating it. Null for tokens issued before D59.
    tokenCiphertext: text("token_ciphertext"),
    expiresAt: timestamptz("expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
    lastViewedAt: timestamptz("last_viewed_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("access_tokens_event_entity_idx").on(table.eventId, table.contactType, table.entityId),
  ],
);

export const emailCampaigns = pgTable(
  "email_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    fromName: text("from_name").notNull(),
    fromEmail: text("from_email").notNull(),
    replyTo: text("reply_to").notNull(),
    subject: text("subject").notNull(),
    htmlBody: text("html_body").notNull(),
    audience: emailAudienceEnum("audience").notNull(),
    // Recipient keys ("buyer:<id>", "supplier_admin:<id>", ...) when audience
    // is "selected" (D60). Keys, not token ids: a contact may have no link yet.
    selectedRecipients: jsonb("selected_recipients").$type<string[]>().notNull().default([]),
    kind: emailCampaignKindEnum("kind").notNull(),
    status: emailCampaignStatusEnum("status").notNull().default("draft"),
    recipientCount: integer("recipient_count"),
    testSentAt: timestamptz("test_sent_at"),
    sentAt: timestamptz("sent_at"),
    sentBy: text("sent_by").references(() => admins.id),
    createdBy: text("created_by").references(() => admins.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("email_campaigns_event_idx").on(table.eventId)],
);

export type EmailDeliveryEvent = {
  /** "sent", "delivered", "bounced", ... (the Resend event type without "email."). */
  type: string;
  at: string;
  detail?: string;
  /** The webhook delivery id, so a retried webhook is recorded once. */
  id?: string;
};

export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => emailCampaigns.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    accessTokenId: uuid("access_token_id").references(() => accessTokens.id, {
      onDelete: "set null",
    }),
    // Who the message is for, independent of the token, which can be
    // regenerated (D60). Supplier contacts use the supplier id.
    contactType: contactTypeEnum("contact_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    recipientName: text("recipient_name").notNull(),
    toEmail: text("to_email").notNull(),
    providerMessageId: text("provider_message_id"),
    status: emailMessageStatusEnum("status").notNull().default("queued"),
    events: jsonb("events").$type<EmailDeliveryEvent[]>().notNull().default([]),
    scheduleHash: text("schedule_hash"),
    sentAt: timestamptz("sent_at"),
    lastEventAt: timestamptz("last_event_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("email_messages_campaign_idx").on(table.campaignId),
    index("email_messages_event_contact_idx").on(table.eventId, table.contactType, table.entityId),
    index("email_messages_provider_id_idx").on(table.providerMessageId),
    index("email_messages_token_idx").on(table.accessTokenId),
  ],
);

// ---------------------------------------------------------------------------
// Relations for db.query joins
// ---------------------------------------------------------------------------

export const adminsRelations = relations(admins, ({ many }) => ({
  sessions: many(sessions),
  invitesSent: many(adminInvites),
  auditEvents: many(auditEvents),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  admin: one(admins, { fields: [sessions.userId], references: [admins.id] }),
}));

export const adminInvitesRelations = relations(adminInvites, ({ one }) => ({
  inviter: one(admins, { fields: [adminInvites.invitedBy], references: [admins.id] }),
}));

export const eventsRelations = relations(events, ({ many }) => ({
  participants: many(participants),
  suppliers: many(suppliers),
  imports: many(imports),
  matchRuns: many(matchRuns),
  auditEvents: many(auditEvents),
  accessTokens: many(accessTokens),
  emailCampaigns: many(emailCampaigns),
}));

export const participantsRelations = relations(participants, ({ one, many }) => ({
  event: one(events, { fields: [participants.eventId], references: [events.id] }),
  appointments: many(appointments),
}));

export const suppliersRelations = relations(suppliers, ({ one, many }) => ({
  event: one(events, { fields: [suppliers.eventId], references: [events.id] }),
  appointments: many(appointments),
}));

export const importsRelations = relations(imports, ({ one, many }) => ({
  event: one(events, { fields: [imports.eventId], references: [events.id] }),
  createdByAdmin: one(admins, { fields: [imports.createdBy], references: [admins.id] }),
  rankings: many(rankings),
}));

export const rankingsRelations = relations(rankings, ({ one }) => ({
  import: one(imports, { fields: [rankings.importId], references: [imports.id] }),
}));

export const matchRunsRelations = relations(matchRuns, ({ one, many }) => ({
  event: one(events, { fields: [matchRuns.eventId], references: [events.id] }),
  parentRun: one(matchRuns, {
    fields: [matchRuns.parentRunId],
    references: [matchRuns.id],
    relationName: "rerun",
  }),
  reruns: many(matchRuns, { relationName: "rerun" }),
  appointments: many(appointments),
  createdByAdmin: one(admins, { fields: [matchRuns.createdBy], references: [admins.id] }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  run: one(matchRuns, { fields: [appointments.runId], references: [matchRuns.id] }),
  buyer: one(participants, { fields: [appointments.buyerId], references: [participants.id] }),
  supplier: one(suppliers, { fields: [appointments.supplierId], references: [suppliers.id] }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  event: one(events, { fields: [auditEvents.eventId], references: [events.id] }),
  admin: one(admins, { fields: [auditEvents.adminId], references: [admins.id] }),
}));

export const accessTokensRelations = relations(accessTokens, ({ one, many }) => ({
  event: one(events, { fields: [accessTokens.eventId], references: [events.id] }),
  emailMessages: many(emailMessages),
}));

export const emailCampaignsRelations = relations(emailCampaigns, ({ one, many }) => ({
  event: one(events, { fields: [emailCampaigns.eventId], references: [events.id] }),
  messages: many(emailMessages),
}));

export const emailMessagesRelations = relations(emailMessages, ({ one }) => ({
  campaign: one(emailCampaigns, {
    fields: [emailMessages.campaignId],
    references: [emailCampaigns.id],
  }),
  accessToken: one(accessTokens, {
    fields: [emailMessages.accessTokenId],
    references: [accessTokens.id],
  }),
}));

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type Admin = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Verification = typeof verifications.$inferSelect;
export type AdminInvite = typeof adminInvites.$inferSelect;
export type NewAdminInvite = typeof adminInvites.$inferInsert;

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Participant = typeof participants.$inferSelect;
export type NewParticipant = typeof participants.$inferInsert;
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type NameAlias = typeof nameAliases.$inferSelect;
export type NewNameAlias = typeof nameAliases.$inferInsert;
export type Import = typeof imports.$inferSelect;
export type NewImport = typeof imports.$inferInsert;
export type Ranking = typeof rankings.$inferSelect;
export type NewRanking = typeof rankings.$inferInsert;
export type MatchRun = typeof matchRuns.$inferSelect;
export type NewMatchRun = typeof matchRuns.$inferInsert;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type AccessToken = typeof accessTokens.$inferSelect;
export type NewAccessToken = typeof accessTokens.$inferInsert;
export type EmailCampaign = typeof emailCampaigns.$inferSelect;
export type NewEmailCampaign = typeof emailCampaigns.$inferInsert;
export type EmailMessage = typeof emailMessages.$inferSelect;
export type NewEmailMessage = typeof emailMessages.$inferInsert;

export type EventStatus = Event["status"];
export type RosterStatus = Participant["status"];
export type SupplierType = Supplier["type"];
export type ImportKind = Import["kind"];
export type ImportStatus = Import["status"];
export type ContactType = AccessToken["contactType"];
export type EmailAudience = EmailCampaign["audience"];
export type EmailCampaignKind = EmailCampaign["kind"];
export type EmailCampaignStatus = EmailCampaign["status"];
export type EmailMessageStatus = EmailMessage["status"];
