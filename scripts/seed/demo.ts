import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, events, matchRuns, rankings, suppliers, type NewRanking } from "@/db/schema";
import { computeStats, type Appointment } from "@/engine";
import { defaultEventSettings } from "@/lib/schemas/event-settings";
import { createEvent } from "@/server/events/events";
import { upsertParticipant, upsertSupplier } from "@/server/roster/roster";
import { planDesks } from "@/server/schedule/lock";
import { createAdminAccount, findAdminId } from "./admin";
import type { Fixture } from "./fixture";
import { demoBuyers, demoSupplierContacts } from "./people";
import { buildDemoRankings } from "./ranks";

/**
 * The demo event: the real 2025 schedule loaded as an active run on top of a
 * synthetic roster and a full set of rankings. Re-running replaces it.
 */

export const DEMO_EVENT_NAME = "AW 2025 Appointment Show";
export const DEMO_TIMEZONE = "America/Los_Angeles";
export const DEMO_ADMIN = { email: "admin@example.com", name: "Demo Admin", password: "demo-password-1234" };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why the demo seed must not run here, or null when it may. The seed creates
 * admin@example.com with a password printed in this repo, so it refuses a
 * production NODE_ENV and any database not on this machine, unless
 * SEED_ALLOW_REMOTE=1 says that is intended (for example a preview branch).
 */
export function seedTargetRefusal(env: {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  SEED_ALLOW_REMOTE?: string;
}): string | null {
  if (env.SEED_ALLOW_REMOTE === "1") return null;
  const override = "Set SEED_ALLOW_REMOTE=1 if you really mean to seed it.";
  if (env.NODE_ENV === "production") {
    return `NODE_ENV is production. The demo seed adds an admin with a published password. ${override}`;
  }
  if (!env.DATABASE_URL) return null;
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname;
  } catch {
    return `DATABASE_URL is not a URL, so it can't be confirmed as a local database. ${override}`;
  }
  if (LOCAL_HOSTS.has(host)) return null;
  return `DATABASE_URL points at ${host}, not localhost. The demo seed adds an admin with a published password. ${override}`;
}

export type SeedSummary = {
  eventId: string;
  adminId: string;
  adminCreated: boolean;
  replacedEvents: number;
  participants: number;
  suppliers: number;
  rankings: number;
  appointments: number;
};

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

async function insertInChunks<T>(rows: T[], size: number, insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

export async function seedDemo(db: Db, fixture: Fixture): Promise<SeedSummary> {
  let adminId = await findAdminId(db, DEMO_ADMIN.email);
  const adminCreated = adminId === null;
  adminId ??= await createAdminAccount(db, DEMO_ADMIN);

  // Idempotent: drop any earlier demo event. Everything under it cascades.
  const removed = await db.delete(events).where(eq(events.name, DEMO_EVENT_NAME)).returning({ id: events.id });

  const { id: eventId } = unwrap(
    await createEvent(db, { name: DEMO_EVENT_NAME, eventDate: fixture.event.date, timezone: DEMO_TIMEZONE }, adminId),
    "Create event",
  );

  const supplierIds = new Map<string, string>();
  for (const s of fixture.suppliers) {
    const contacts = demoSupplierContacts(s.name);
    const { id } = unwrap(
      await upsertSupplier(db, {
        eventId,
        adminId,
        data: { name: s.name, type: s.type, deskOverride: false, ...contacts },
      }),
      `Supplier ${s.name}`,
    );
    supplierIds.set(s.name, id);
  }
  // Desks follow the lock rule (D17) through the same planner, so locking the
  // demo keeps every number. The 2025 file sorted by code point ("eShow" last).
  const supplierRows = await db.select().from(suppliers).where(eq(suppliers.eventId, eventId));
  for (const plan of planDesks(supplierRows)) {
    await db.update(suppliers).set({ deskNumber: plan.desk }).where(eq(suppliers.id, plan.supplierId));
  }

  const buyerIds = new Map<string, string>();
  const identities = demoBuyers(fixture.buyers);
  for (const [i, b] of fixture.buyers.entries()) {
    const person = identities[i];
    const { id } = unwrap(
      await upsertParticipant(db, {
        eventId,
        adminId,
        // Every 2025 buyer ranked the business suppliers, so all are opted in (D1).
        data: { ...person, displayName: null, biztechOptIn: true },
      }),
      `Participant ${b.name}`,
    );
    buyerIds.set(b.name, id);
  }

  const idOf = (type: "buyer" | "supplier", name: string): string => {
    const id = (type === "buyer" ? buyerIds : supplierIds).get(name);
    if (!id) throw new Error(`No ${type} named ${name}`);
    return id;
  };

  const demoRankings = buildDemoRankings({
    buyers: fixture.buyers.map((b) => b.name),
    suppliers: fixture.suppliers,
    appointments: fixture.appointments,
  });
  const rankingRows: NewRanking[] = demoRankings.map((r) => ({
    eventId,
    rankerType: r.rankerType,
    rankerId: idOf(r.rankerType, r.ranker),
    targetType: r.targetType,
    targetId: idOf(r.targetType, r.target),
    rank: r.rank,
    isRejection: false,
  }));
  await insertInChunks(rankingRows, 1000, (chunk) => db.insert(rankings).values(chunk));

  const schedule: Appointment[] = fixture.appointments.map((a) => ({
    slot: a.slot,
    buyerId: idOf("buyer", a.buyer),
    supplierId: idOf("supplier", a.supplier),
    buyerRank: a.buyerRank,
    supplierRank: a.supplierRank,
    source: "engine",
    pinned: false,
  }));
  const stats = computeStats(schedule, {
    settings: defaultEventSettings,
    buyers: [...buyerIds.values()].map((id) => ({ id, biztechOptIn: true })),
    suppliers: fixture.suppliers.map((s) => ({ id: idOf("supplier", s.name), type: s.type })),
  });

  // The 2025 schedule is historical, so it goes in as a finished run rather than through startRun.
  await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(matchRuns)
      .values({
        eventId,
        status: "completed",
        settingsSnapshot: defaultEventSettings,
        stats,
        warnings: [],
        durationMs: 0,
        isActive: true,
        createdBy: adminId,
        completedAt: new Date(),
      })
      .returning({ id: matchRuns.id });
    await insertInChunks(schedule, 500, (chunk) =>
      tx.insert(appointments).values(chunk.map((a) => ({ ...a, runId: run.id, eventId }))),
    );
    await tx.update(events).set({ status: "matched" }).where(eq(events.id, eventId));
  });

  return {
    eventId,
    adminId,
    adminCreated,
    replacedEvents: removed.length,
    participants: buyerIds.size,
    suppliers: supplierIds.size,
    rankings: rankingRows.length,
    appointments: schedule.length,
  };
}
