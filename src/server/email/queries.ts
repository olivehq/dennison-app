import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import {
  admins,
  emailCampaigns,
  emailMessages,
  type ContactType,
  type EmailCampaign,
  type EmailDeliveryEvent,
  type EmailMessageStatus,
} from "@/db/schema";
import { recipientKey } from "@/lib/schemas/email";
import { listAudienceContacts } from "./recipients";
import { scheduleChangeState, type ScheduleChangeState } from "./schedule-hash";

/** Reads for the emails pages, the roster "changed since last email" column, and the overview. */

export const MESSAGE_STATUSES: readonly EmailMessageStatus[] = [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
];

export type StatusCounts = Record<EmailMessageStatus, number> & { total: number };

function emptyCounts(): StatusCounts {
  return { total: 0, queued: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0 };
}

type LatestMessage = typeof emailMessages.$inferSelect;

/** The newest message per recipient in each campaign, so a resend replaces the bounce it retried. */
async function latestMessages(db: Db, where: { eventId?: string; campaignId?: string }): Promise<LatestMessage[]> {
  const condition = where.campaignId
    ? eq(emailMessages.campaignId, where.campaignId)
    : eq(emailMessages.eventId, where.eventId!);
  return db
    .selectDistinctOn([emailMessages.campaignId, emailMessages.contactType, emailMessages.entityId])
    .from(emailMessages)
    .where(condition)
    .orderBy(emailMessages.campaignId, emailMessages.contactType, emailMessages.entityId, desc(emailMessages.createdAt));
}

function countByCampaign(rows: LatestMessage[]): Map<string, StatusCounts> {
  const counts = new Map<string, StatusCounts>();
  for (const row of rows) {
    const c = counts.get(row.campaignId) ?? emptyCounts();
    c[row.status] += 1;
    c.total += 1;
    counts.set(row.campaignId, c);
  }
  return counts;
}

export type CampaignListItem = Pick<
  EmailCampaign,
  "id" | "name" | "kind" | "audience" | "status" | "recipientCount" | "sentAt" | "createdAt"
> & { counts: StatusCounts };

/** Every campaign of the event, newest first, with message counts by status. */
export async function listCampaigns(eventId: string, db: Db = getDb()): Promise<CampaignListItem[]> {
  const [campaigns, messages] = await Promise.all([
    db
      .select()
      .from(emailCampaigns)
      .where(eq(emailCampaigns.eventId, eventId))
      .orderBy(desc(emailCampaigns.createdAt)),
    latestMessages(db, { eventId }),
  ]);
  const counts = countByCampaign(messages);
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    audience: c.audience,
    status: c.status,
    recipientCount: c.recipientCount,
    sentAt: c.sentAt,
    createdAt: c.createdAt,
    counts: counts.get(c.id) ?? emptyCounts(),
  }));
}

export async function campaignStats(campaignId: string, db: Db = getDb()): Promise<StatusCounts> {
  const messages = await latestMessages(db, { campaignId });
  return countByCampaign(messages).get(campaignId) ?? emptyCounts();
}

export type DeliveryRow = {
  id: string;
  key: string;
  contactType: ContactType;
  name: string;
  email: string;
  status: EmailMessageStatus;
  sentAt: Date | null;
  lastEvent: EmailDeliveryEvent | null;
  /** Why it bounced, failed, or was suppressed. */
  reason: string | null;
  /** Messages to this recipient in the campaign, more than one after a resend. */
  attempts: number;
};

export type CampaignDetail = {
  campaign: EmailCampaign;
  sentByName: string | null;
  messages: DeliveryRow[];
  stats: StatusCounts;
};

function lastOf(events: EmailDeliveryEvent[]): EmailDeliveryEvent | null {
  return events.length > 0 ? events[events.length - 1] : null;
}

function reasonOf(row: LatestMessage): string | null {
  if (row.status !== "bounced" && row.status !== "failed" && row.status !== "complained") return null;
  const withDetail = [...row.events].reverse().find((e) => e.detail);
  if (withDetail?.detail) return withDetail.detail;
  return row.status === "complained" ? "Marked as spam" : null;
}

/** The campaign with one delivery row per recipient (the newest message), or null. */
export async function getCampaign(campaignId: string, db: Db = getDb()): Promise<CampaignDetail | null> {
  const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaignId)).limit(1);
  if (!campaign) return null;
  const [latest, all, sender] = await Promise.all([
    latestMessages(db, { campaignId }),
    db
      .select({ contactType: emailMessages.contactType, entityId: emailMessages.entityId })
      .from(emailMessages)
      .where(eq(emailMessages.campaignId, campaignId)),
    campaign.sentBy
      ? db.select({ name: admins.name }).from(admins).where(eq(admins.id, campaign.sentBy)).limit(1)
      : Promise.resolve([]),
  ]);
  const attempts = new Map<string, number>();
  for (const m of all) {
    const key = recipientKey(m.contactType, m.entityId);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  }
  const messages: DeliveryRow[] = latest
    .map((m) => {
      const key = recipientKey(m.contactType, m.entityId);
      return {
        id: m.id,
        key,
        contactType: m.contactType,
        name: m.recipientName,
        email: m.toEmail,
        status: m.status,
        sentAt: m.sentAt,
        lastEvent: lastOf(m.events),
        reason: reasonOf(m),
        attempts: attempts.get(key) ?? 1,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return {
    campaign,
    sentByName: sender[0]?.name ?? null,
    messages,
    stats: countByCampaign(latest).get(campaignId) ?? emptyCounts(),
  };
}

export type AudienceOption = { key: string; contactType: ContactType; name: string; email: string };

export type AudienceOptions = {
  contacts: AudienceOption[];
  /** Recipients per audience, except `selected`, which the editor counts from its selection. */
  counts: { all: number; buyers: number; suppliers: number; changed_since_last_send: number };
};

/** Contacts and audience sizes for the campaign editor. Never includes links. */
export async function getAudienceOptions(eventId: string, db: Db = getDb()): Promise<AudienceOptions | null> {
  const [contacts, state] = await Promise.all([listAudienceContacts(db, eventId), scheduleChangeState(db, eventId)]);
  if (!contacts) return null;
  const buyers = contacts.filter((c) => c.contactType === "buyer").length;
  return {
    contacts: contacts.map((c) => ({ key: c.key, contactType: c.contactType, name: c.name, email: c.email })),
    counts: {
      all: contacts.length,
      buyers,
      suppliers: contacts.length - buyers,
      changed_since_last_send: contacts.filter((c) => state.changed.has(c.key)).length,
    },
  };
}

/** Who has been emailed and whose schedule changed since (D13), for the roster pages. */
export async function getScheduleChangeState(eventId: string, db: Db = getDb()): Promise<ScheduleChangeState> {
  return scheduleChangeState(db, eventId);
}

export type EmailSummary = {
  /** Contacts whose schedule changed since their last email. */
  changed: number;
  /** At least one campaign reached someone. */
  hasSent: boolean;
};

export async function getEmailSummary(eventId: string, db: Db = getDb()): Promise<EmailSummary> {
  const [state, [sentCampaign]] = await Promise.all([
    scheduleChangeState(db, eventId),
    db
      .select({ id: emailCampaigns.id })
      .from(emailCampaigns)
      .where(and(eq(emailCampaigns.eventId, eventId), inArray(emailCampaigns.status, ["sent"])))
      .limit(1),
  ]);
  return { changed: state.changed.size, hasSent: sentCampaign !== undefined || state.emailed.size > 0 };
}
