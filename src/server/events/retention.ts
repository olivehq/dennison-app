import { and, eq, inArray, isNotNull, isNull, lt, notLike, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  accessTokens,
  appointments,
  auditEvents,
  emailMessages,
  events,
  imports,
  matchRuns,
  nameAliases,
  participants,
  rankings,
  suppliers,
  type Event,
} from "@/db/schema";
import { deleteFile } from "@/lib/storage";
import { endOfDayInTimezone } from "@/lib/time";
import { recordAudit } from "@/server/audit/audit";

/**
 * Data retention (SOW 4, scope section 8): participant data is deleted 90
 * days after the event unless D&A asked to keep it (`settings.retainData`).
 * Run daily by the Vercel cron at `/api/cron/retention`.
 */

export const RETENTION_DAYS = 90;

/** The first instant the event's data may be deleted: after the 90th day ends, in the event timezone. */
export function retentionDeadline(event: Pick<Event, "eventDate" | "timezone">): Date {
  return new Date(endOfDayInTimezone(event.eventDate, event.timezone, RETENTION_DAYS).getTime() + 1);
}

/** The calendar day the daily cron deletes the data (the day after the 90th), as YYYY-MM-DD. */
export function retentionDeleteDate(eventDate: string): string {
  const [year, month, day] = eventDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + RETENTION_DAYS + 1)).toISOString().slice(0, 10);
}

export type RetentionCounts = {
  participants: number;
  suppliers: number;
  rankings: number;
  imports: number;
  files: number;
  nameAliases: number;
  matchRuns: number;
  appointments: number;
  accessTokens: number;
  emailMessages: number;
  auditRowsRedacted: number;
};

export type RetentionResult = {
  eventId: string;
  name: string;
  deleted: RetentionCounts;
  /** Storage keys that could not be deleted; the rows are gone, so retry by hand. */
  fileErrors: string[];
};

function isDue(event: Event, now: Date): boolean {
  return event.settings.retainData !== true && retentionDeadline(event) <= now;
}

function isEmpty(counts: RetentionCounts): boolean {
  return Object.values(counts).every((n) => n === 0);
}

/**
 * Deletes participant data of every event past its retention deadline and
 * archives it. One transaction and one audit row per event; stored import
 * files are deleted after the rows commit. Events already archived with
 * nothing left to delete are skipped, so the daily run is quiet.
 */
export async function deleteExpiredParticipantData(db: Db, now: Date = new Date()): Promise<RetentionResult[]> {
  // Cheap prefilter on the date column; the exact per-timezone check is isDue.
  const cutoff = new Date(now.getTime() - (RETENTION_DAYS - 2) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const candidates = (await db.select().from(events).where(lt(events.eventDate, cutoff))).filter((e) => isDue(e, now));

  const results: RetentionResult[] = [];
  for (const event of candidates) {
    const outcome = await db.transaction(async (tx) => {
      const files = await tx.select({ key: imports.fileKey }).from(imports).where(eq(imports.eventId, event.id));
      const gone = async (rows: Promise<{ id: string }[]>) => (await rows).length;
      const counts: RetentionCounts = {
        // Children first, so each count is what this job removed rather than a cascade.
        emailMessages: await gone(tx.delete(emailMessages).where(eq(emailMessages.eventId, event.id)).returning({ id: emailMessages.id })),
        accessTokens: await gone(tx.delete(accessTokens).where(eq(accessTokens.eventId, event.id)).returning({ id: accessTokens.id })),
        appointments: await gone(tx.delete(appointments).where(eq(appointments.eventId, event.id)).returning({ id: appointments.id })),
        // Runs store warnings with people's names in them (D34).
        matchRuns: await gone(tx.delete(matchRuns).where(eq(matchRuns.eventId, event.id)).returning({ id: matchRuns.id })),
        rankings: await gone(tx.delete(rankings).where(eq(rankings.eventId, event.id)).returning({ id: rankings.id })),
        // Event aliases, plus the cross-year buyer aliases (D76) that point at this
        // event's buyers: they hold personal names. Supplier ones are business names.
        nameAliases:
          (await gone(tx.delete(nameAliases).where(eq(nameAliases.eventId, event.id)).returning({ id: nameAliases.id }))) +
          (await gone(
            tx
              .delete(nameAliases)
              .where(
                and(
                  isNull(nameAliases.eventId),
                  eq(nameAliases.entityType, "buyer"),
                  inArray(
                    nameAliases.entityId,
                    tx.select({ id: participants.id }).from(participants).where(eq(participants.eventId, event.id)),
                  ),
                ),
              )
              .returning({ id: nameAliases.id }),
          )),
        imports: await gone(tx.delete(imports).where(eq(imports.eventId, event.id)).returning({ id: imports.id })),
        participants: await gone(tx.delete(participants).where(eq(participants.eventId, event.id)).returning({ id: participants.id })),
        suppliers: await gone(tx.delete(suppliers).where(eq(suppliers.eventId, event.id)).returning({ id: suppliers.id })),
        files: files.length,
        // The log keeps who did what and when; before, after, and notes of
        // roster, schedule, import, link, and email rows held names and emails.
        auditRowsRedacted: await gone(
          tx
            .update(auditEvents)
            .set({ before: null, after: null, note: null })
            .where(
              and(
                eq(auditEvents.eventId, event.id),
                // Event-level rows (name, settings, retention) hold no personal data.
                notLike(auditEvents.action, "event.%"),
                or(isNotNull(auditEvents.before), isNotNull(auditEvents.after), isNotNull(auditEvents.note)),
              ),
            )
            .returning({ id: auditEvents.id }),
        ),
      };
      if (event.status === "archived" && isEmpty(counts)) return null;

      await tx.update(events).set({ status: "archived" }).where(eq(events.id, event.id));
      await recordAudit(tx, {
        eventId: event.id,
        adminId: null,
        action: "event.retention_delete",
        entityType: "event",
        entityId: event.id,
        before: { status: event.status },
        after: { status: "archived", deleted: counts, deadline: retentionDeadline(event).toISOString() },
      });
      return { counts, keys: files.map((f) => f.key) };
    });
    if (!outcome) continue;

    const fileErrors: string[] = [];
    for (const key of outcome.keys) {
      try {
        await deleteFile(key);
      } catch {
        fileErrors.push(key);
      }
    }
    results.push({ eventId: event.id, name: event.name, deleted: outcome.counts, fileErrors });
  }
  return results;
}
