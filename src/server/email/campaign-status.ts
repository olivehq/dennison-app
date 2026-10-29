import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { emailCampaigns, type EmailCampaign, type EmailCampaignStatus } from "@/db/schema";
import { recordAudit } from "@/server/audit/audit";

/**
 * The campaign status machine. Every status write goes through
 * `transitionCampaign`; nothing else updates `email_campaigns.status`.
 *
 *   draft ──claim──▶ sending ──finish──▶ sent | failed
 *                      │  ▲                  │
 *                      │  └─────claim────────┘  (retry delivery)
 *                      └──nothing to send──▶ draft
 *
 * A send runs inside one request. A `sending` campaign older than
 * `STALE_SEND_HOURS` died with its request; `repairStaleSends` marks it failed.
 */

const MOVES: Record<EmailCampaignStatus, readonly EmailCampaignStatus[]> = {
  draft: ["sending"],
  sending: ["draft", "sent", "failed"],
  sent: ["sending"],
  failed: ["sending"],
};

/** Columns a move may set along with the status: the record of a finished send. */
export type CampaignSendRecord = Partial<Pick<EmailCampaign, "sentAt" | "sentBy" | "recipientCount">>;

/**
 * Moves the campaign to `to` only when its status is `from` (one status or
 * several): a compare-and-set in one UPDATE, like `advanceStatus` for events.
 * Returns the updated row, or null when the status was not `from`. A move the
 * machine does not allow throws, since it is a bug, not a race.
 *
 *   await transitionCampaign(tx, campaign.id, "draft", "sending");
 */
export async function transitionCampaign(
  db: Db,
  campaignId: string,
  from: EmailCampaignStatus | readonly EmailCampaignStatus[],
  to: EmailCampaignStatus,
  record: CampaignSendRecord = {},
): Promise<EmailCampaign | null> {
  const allowed = typeof from === "string" ? [from] : [...from];
  const illegal = allowed.filter((status) => !MOVES[status].includes(to));
  if (illegal.length > 0) throw new Error(`A campaign can't move from ${illegal.join(" or ")} to ${to}.`);
  if (allowed.length === 0) return null;
  const [row] = await db
    .update(emailCampaigns)
    .set({ ...record, status: to })
    .where(and(eq(emailCampaigns.id, campaignId), inArray(emailCampaigns.status, allowed)))
    .returning();
  return row ?? null;
}

/**
 * A campaign still `sending` this long after its claim died with its request.
 * A send runs inside one server request, and the platform stops a request
 * after minutes, not hours, so nothing real is still sending after 6 hours.
 * The margin is wide because failing a live send would let retention delete
 * messages it is still writing, or let unlock change the schedule under it.
 */
export const STALE_SEND_HOURS = 6;

/** The reason the `email.send` audit row gives for a send it marked failed as stale. */
export const STALE_SEND_REASON = `The send stopped without finishing and was still marked sending after ${STALE_SEND_HOURS} hours, so it was marked failed.`;

/** A stale send `repairStaleSends` marked failed, with its audit row. */
export type StaleSendRepair = { campaignId: string; auditId: string };

/**
 * Moves the event's campaigns that have been `sending` for more than
 * `STALE_SEND_HOURS` before `now` (by `updatedAt`, which the claim sets and
 * nothing else changes mid-send) to `failed`, each with an `email.send` audit
 * row (adminId null, `STALE_SEND_REASON`). Unlock and archive run it through
 * `hasSendInProgress`, so a dead send blocks them for at most
 * `STALE_SEND_HOURS`; retention runs it with its own `now`. Call it with the
 * event row locked.
 */
export async function repairStaleSends(tx: Db, eventId: string, now: Date = new Date()): Promise<StaleSendRepair[]> {
  const cutoff = new Date(now.getTime() - STALE_SEND_HOURS * 60 * 60 * 1000);
  const stale = await tx
    .select({ id: emailCampaigns.id })
    .from(emailCampaigns)
    .where(and(eq(emailCampaigns.eventId, eventId), eq(emailCampaigns.status, "sending"), lt(emailCampaigns.updatedAt, cutoff)));
  const repaired: StaleSendRepair[] = [];
  for (const { id } of stale) {
    if (!(await transitionCampaign(tx, id, "sending", "failed"))) continue;
    console.warn(`[email] event ${eventId}: campaign ${id} was stuck sending, marked it failed.`);
    const audit = await recordAudit(tx, {
      eventId,
      adminId: null,
      action: "email.send",
      entityType: "email_campaign",
      entityId: id,
      before: { status: "sending" },
      after: { status: "failed", failureReason: STALE_SEND_REASON },
    });
    repaired.push({ campaignId: id, auditId: audit.id });
  }
  return repaired;
}
