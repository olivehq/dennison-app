import { and, count, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db/client";
import { appointments, participants, suppliers } from "@/db/schema";
import type { ImportState } from "@/lib/schemas/import";
import { getImportStatusByKind } from "@/server/imports/queries";
import { findActiveRun } from "@/server/matching/runs";
import { countActiveRoster, getEvent } from "./queries";

export type EventNavCounts = {
  /** Active participants. */
  participants: number;
  /** Active suppliers. */
  suppliers: number;
  /** Kinds whose latest file that isn't ignored is checked but not applied, or needs mapping or fixes. */
  importsWaiting: number;
  /**
   * The schedule's Quality badge: people off their count target plus meetings
   * with someone who withdrew. Null when no schedule is active.
   */
  scheduleProblems: number | null;
};

const WAITING_STATES: readonly ImportState[] = ["ready", "needs_mapping", "needs_fixes"];

async function countImportsWaiting(db: Db, eventId: string): Promise<number> {
  // The same latest-file read as the upload cards and matching readiness.
  const latest = Object.values(await getImportStatusByKind(eventId, db));
  return latest.filter((summary) => summary && WAITING_STATES.includes(summary.state)).length;
}

/**
 * The same rule as `attentionCount` plus the withdrawn list in the schedule
 * workspace: active suppliers off the target, active buyers outside min to
 * max, and meetings that still name someone who withdrew.
 */
async function countScheduleProblems(
  db: Db,
  eventId: string,
  runId: string,
  targets: { supplierTarget: number; buyerMin: number; buyerMax: number },
): Promise<number> {
  const supplierMeetings = db
    .select({ n: count() })
    .from(appointments)
    .where(and(eq(appointments.runId, runId), eq(appointments.supplierId, suppliers.id)));
  const buyerMeetings = db
    .select({ n: count() })
    .from(appointments)
    .where(and(eq(appointments.runId, runId), eq(appointments.buyerId, participants.id)));

  const [[offTarget], [outOfRange], [withdrawnMeetings]] = await Promise.all([
    db
      .select({ n: count() })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.eventId, eventId),
          eq(suppliers.status, "active"),
          sql`(${supplierMeetings}) <> ${targets.supplierTarget}`,
        ),
      ),
    db
      .select({ n: count() })
      .from(participants)
      .where(
        and(
          eq(participants.eventId, eventId),
          eq(participants.status, "active"),
          sql`(${buyerMeetings}) not between ${targets.buyerMin} and ${targets.buyerMax}`,
        ),
      ),
    db
      .select({ n: count() })
      .from(appointments)
      .innerJoin(participants, eq(participants.id, appointments.buyerId))
      .innerJoin(suppliers, eq(suppliers.id, appointments.supplierId))
      .where(
        and(
          eq(appointments.runId, runId),
          or(eq(participants.status, "withdrawn"), eq(suppliers.status, "withdrawn")),
        ),
      ),
  ]);
  return (offTarget?.n ?? 0) + (outOfRange?.n ?? 0) + (withdrawnMeetings?.n ?? 0);
}

/** The sidebar counts for one event. Counts only; null when the event doesn't exist or the id isn't a uuid. */
export async function getEventNavCounts(eventId: string, db: Db = getDb()): Promise<EventNavCounts | null> {
  if (!z.uuid().safeParse(eventId).success) return null;
  // The event and active run are the same reads the layout and page make, so a render shares them.
  // The roster counts too: the overview and matching pages read them in the same render.
  const [event, activeRun, roster, importsWaiting] = await Promise.all([
    getEvent(eventId, db),
    findActiveRun(db, eventId),
    countActiveRoster(db, eventId),
    countImportsWaiting(db, eventId),
  ]);
  if (!event) return null;

  return {
    participants: roster.participants,
    suppliers: roster.suppliers,
    importsWaiting,
    scheduleProblems: activeRun ? await countScheduleProblems(db, eventId, activeRun.id, event.settings) : null,
  };
}
