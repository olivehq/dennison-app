import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import {
  accessTokens,
  appointments,
  emailCampaigns,
  events,
  matchRuns,
  participants,
  rankings,
  suppliers,
  type Appointment,
} from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { NOT_ACTIVE_RUN_MESSAGE } from "@/lib/schemas/schedule";
import { listAudit } from "@/server/audit/audit";
import { SEND_IN_PROGRESS_MESSAGE } from "@/server/events/status";
import { raceBeforeTransaction } from "@/server/events/test-race";
import { getActiveRun } from "@/server/matching/queries";
import { activateRun, setPinned, startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import {
  addAppointment,
  removeAppointment,
  replaceAppointment,
  swapCandidates,
  undoAudit,
  UNDO_CONFLICT_HINT,
  VERSION_CONFLICT_MESSAGE,
  type SwapCandidate,
} from "./edits";
import { lockSchedule, planDesks, reassignDesks, unlockSchedule } from "./lock";
import { getScheduleView } from "./queries";
import { getScheduleViewSnapshot } from "./views";
import { loadPersonSchedule } from "./snapshot";

let db: Db;
let seeded: Seeded;
let runId: string;

async function rows(): Promise<Appointment[]> {
  return db.select().from(appointments).where(eq(appointments.runId, runId));
}

async function version(): Promise<number> {
  const run = await getActiveRun(seeded.eventId, db);
  if (!run) throw new Error("no active run");
  return run.version;
}

function supplierNamed(name: string) {
  const s = seeded.suppliers.find((x) => x.name === name);
  if (!s) throw new Error(`no supplier ${name}`);
  return s;
}

/** Removes the first appointment of the active run and returns it. */
async function removeOne(): Promise<Appointment> {
  const [first] = await rows();
  const result = await removeAppointment(
    db,
    { runId, version: await version(), slot: first.slot, supplierId: first.supplierId, buyerId: first.buyerId },
    seeded.adminId,
  );
  if (!result.ok) throw new Error(result.error.message);
  return first;
}

/** An engine-placed appointment that has at least one swap candidate, with the candidates. */
async function replaceableRow(): Promise<{ target: Appointment; pick: SwapCandidate }> {
  for (const target of (await rows()).filter((a) => a.source === "engine")) {
    const candidates = await swapCandidates(db, {
      runId,
      supplierId: target.supplierId,
      slot: target.slot,
      excludeBuyerId: target.buyerId,
    });
    if (candidates.ok && candidates.data.length > 0) return { target, pick: candidates.data[0] };
  }
  throw new Error("no appointment in the fixture has a swap candidate");
}

// One database for the file; every test gets its own event and active run, so
// tests pass in any order and on their own (`-t`, `--sequence.shuffle`).
beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  seeded = await seedEvent(db);
  const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
  if (!run.ok) throw new Error(run.error.message);
  runId = run.data.runId;
});

describe("getScheduleView", () => {
  it("returns the workspace data for the active run", async () => {
    const view = await getScheduleView(seeded.eventId, db);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.run?.id).toBe(runId);
    expect(view.run?.version).toBe(1);
    expect(view.run?.stats?.totalAppointments).toBe(view.appointments.length);
    expect(view.slots).toHaveLength(9);
    expect(view.slots[0]).toMatchObject({ slot: 1, start: "3:10 PM", end: "3:20 PM" });
    expect(view.suppliers.map((s) => s.name)).toEqual([
      "Alpha Audio",
      "Bravo Lighting",
      "Carmel Valley Ranch",
      "Delta Staging",
      "Hyatt Regency Monterey",
      "Monterey Plaza Hotel",
    ]);
    expect(view.suppliers.every((s) => s.count === 9)).toBe(true);
    expect(view.buyers).toHaveLength(12);
    expect(view.buyers.find((b) => b.organization === "Org 0")?.name).toBe("Org 0 - Title 0");
    expect(view.buyers.find((b) => b.organization === null)?.name).toMatch(/^Buyer\d+ Person$/);
    const total = view.buyers.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(view.appointments.length);
    for (const a of view.appointments) {
      expect(["mutual", "buyer", "supplier", "neither", "blank"]).toContain(a.strength);
      expect(a.mutualTopN).toBe(a.strength === "mutual");
      if (a.strength === "mutual") {
        expect(a.buyerRank).not.toBeNull();
        expect(a.buyerRank as number).toBeLessThanOrEqual(3);
        expect(a.supplierRank as number).toBeLessThanOrEqual(3);
      }
    }
    expect(view.health.suppliersOffTarget).toEqual([]);
    expect(Array.isArray(view.health.buyersBelowMin)).toBe(true);
  });

  it("getScheduleViewSnapshot reads the same view (a savepoint inside a transaction still works)", async () => {
    const view = await getScheduleView(seeded.eventId, db);
    expect(await getScheduleViewSnapshot(seeded.eventId, db)).toEqual(view);
    expect(await db.transaction((tx) => getScheduleViewSnapshot(seeded.eventId, tx))).toEqual(view);
    expect(await getScheduleViewSnapshot("not-a-uuid", db)).toBeNull();
  });

  it("getScheduleViewSnapshot pairs the run version with its own appointments when a save lands during the read", async () => {
    const before = (await rows()).length;
    const [view] = await Promise.all([getScheduleViewSnapshot(seeded.eventId, db), removeOne()]);
    expect(view?.run?.version === 1 ? before : before - 1).toBe(view?.appointments.length);
  });

  it("loadPersonSchedule shows OPEN gaps and no ranks", async () => {
    const buyer = seeded.buyers[0];
    const mine = (await rows()).filter((a) => a.buyerId === buyer.id);
    const schedule = await loadPersonSchedule(db, seeded.eventId, { type: "buyer", id: buyer.id });
    expect(schedule?.slots).toHaveLength(9);
    expect(schedule?.slots.filter((s) => s.appointment !== null)).toHaveLength(mine.length);
    expect(schedule?.slots.filter((s) => s.appointment === null).length).toBe(9 - mine.length);
    for (const slot of schedule?.slots ?? []) {
      if (!slot.appointment) continue;
      expect(slot.appointment).not.toHaveProperty("buyerRank");
      expect(slot.appointment).not.toHaveProperty("supplierRank");
      expect(slot.appointment).not.toHaveProperty("strength");
      expect(slot.appointment.counterpartName).not.toBe("");
    }

    const supplier = await loadPersonSchedule(db, seeded.eventId, { type: "supplier", id: seeded.suppliers[0].id });
    expect(supplier?.slots.every((s) => s.appointment !== null)).toBe(true);
    expect(await loadPersonSchedule(db, seeded.eventId, { type: "buyer", id: seeded.suppliers[0].id })).toBeNull();
  });
});

describe("edits", () => {
  it("refuses a stale version", async () => {
    const [a] = await rows();
    const result = await removeAppointment(
      db,
      { runId, version: 99, slot: a.slot, supplierId: a.supplierId, buyerId: a.buyerId },
      seeded.adminId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("conflict");
      expect(result.error.message).toBe(VERSION_CONFLICT_MESSAGE);
    }
  });

  it("removes an appointment, bumps the version, recomputes stats, and audits", async () => {
    const all = await rows();
    const removed = all[0];
    const v = await version();
    const result = await removeAppointment(
      db,
      { runId, version: v, slot: removed.slot, supplierId: removed.supplierId, buyerId: removed.buyerId },
      seeded.adminId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.version).toBe(v + 1);
    expect(result.data.eventId).toBe(seeded.eventId);
    expect(result.data.affected).toHaveLength(2);
    const buyer = result.data.affected.find((p) => p.type === "buyer");
    expect(buyer?.after).toBe((buyer?.before ?? 0) - 1);

    const run = await getActiveRun(seeded.eventId, db);
    expect(run?.stats?.totalAppointments).toBe(all.length - 1);
    expect(run?.stats?.suppliersOffTarget).toEqual([{ id: removed.supplierId, count: 8 }]);

    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.remove" } }, db);
    expect(audit.rows[0].id).toBe(result.data.auditEventId);
    expect(audit.rows[0].before).toMatchObject({ slot: removed.slot, buyerId: removed.buyerId });
    expect(audit.rows[0].after).toBeNull();
  });

  it("refuses a double booking with the slot in the reason", async () => {
    // Open a supplier slot, then offer a buyer who is busy elsewhere in that slot, eligible,
    // and not already paired with the supplier, so the double booking is the only rule it breaks.
    const all = await rows();
    const ineligible = new Set([seeded.buyers[0].id, seeded.buyers[seeded.buyers.length - 1].id]);
    let removed: Appointment | undefined;
    let busy: Appointment | undefined;
    for (const candidate of all) {
      const paired = new Set(all.filter((a) => a.supplierId === candidate.supplierId).map((a) => a.buyerId));
      busy = all.find(
        (a) =>
          a.slot === candidate.slot &&
          a.supplierId !== candidate.supplierId &&
          !paired.has(a.buyerId) &&
          !ineligible.has(a.buyerId),
      );
      if (busy) {
        removed = candidate;
        break;
      }
    }
    if (!removed || !busy) throw new Error("fixture has no busy buyer to offer");
    const cleared = await removeAppointment(
      db,
      { runId, version: await version(), slot: removed.slot, supplierId: removed.supplierId, buyerId: removed.buyerId },
      seeded.adminId,
    );
    expect(cleared.ok).toBe(true);
    const result = await addAppointment(
      db,
      { runId, version: await version(), slot: removed.slot, supplierId: removed.supplierId, buyerId: busy.buyerId },
      seeded.adminId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("conflict");
      expect(result.error.message).toContain(`slot ${removed.slot}`);
    }
  });

  it("refuses a duplicate pair", async () => {
    const removed = await removeOne();
    const all = await rows();
    const busyInSlot = new Set(all.filter((a) => a.slot === removed.slot).map((a) => a.buyerId));
    const paired = all.find((a) => a.supplierId === removed.supplierId && !busyInSlot.has(a.buyerId));
    if (!paired) throw new Error("fixture has no free buyer already paired with the supplier");
    const result = await addAppointment(
      db,
      { runId, version: await version(), slot: removed.slot, supplierId: removed.supplierId, buyerId: paired.buyerId },
      seeded.adminId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("conflict");
      expect(result.error.message).toMatch(/already meet in slot/);
    }
  });

  it("refuses a rejected pair and a biztech opt-out, then fills the slot with a candidate", async () => {
    const delta = supplierNamed("Delta Staging");
    const rejecting = seeded.buyers[0];
    const optedOut = seeded.buyers[seeded.buyers.length - 1];
    const all = await rows();
    const busyByBuyer = (id: string) => new Set(all.filter((a) => a.buyerId === id).map((a) => a.slot));
    const deltaRow = all.find(
      (a) => a.supplierId === delta.id && !busyByBuyer(rejecting.id).has(a.slot) && !busyByBuyer(optedOut.id).has(a.slot),
    );
    if (!deltaRow) throw new Error("fixture has no Delta slot free for both buyers");

    const cleared = await removeAppointment(
      db,
      { runId, version: await version(), slot: deltaRow.slot, supplierId: delta.id, buyerId: deltaRow.buyerId },
      seeded.adminId,
    );
    expect(cleared.ok).toBe(true);

    const rejected = await addAppointment(
      db,
      { runId, version: await version(), slot: deltaRow.slot, supplierId: delta.id, buyerId: rejecting.id },
      seeded.adminId,
    );
    expect(!rejected.ok && rejected.error.message).toMatch(/N\/A/);

    const biztech = await addAppointment(
      db,
      { runId, version: await version(), slot: deltaRow.slot, supplierId: delta.id, buyerId: optedOut.id },
      seeded.adminId,
    );
    expect(!biztech.ok && biztech.error.message).toMatch(/biztech/);

    const candidates = await swapCandidates(db, { runId, supplierId: delta.id, slot: deltaRow.slot });
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;
    const ids = candidates.data.map((c) => c.buyerId);
    expect(ids).not.toContain(rejecting.id);
    expect(ids).not.toContain(optedOut.id);
    expect(candidates.data.length).toBeGreaterThan(0);
    const first = candidates.data[0];
    const added = await addAppointment(
      db,
      { runId, version: await version(), slot: deltaRow.slot, supplierId: delta.id, buyerId: first.buyerId },
      seeded.adminId,
    );
    expect(added.ok).toBe(true);
    const after = await rows();
    const row = after.find((a) => a.slot === deltaRow.slot && a.supplierId === delta.id);
    expect(row?.buyerId).toBe(first.buyerId);
    expect(row?.source).toBe("manual");
    expect(row?.buyerRank).toBe(first.buyerRank);
    expect(row?.supplierRank).toBe(first.supplierRank);
  });

  it("swapCandidates lists only free, unpaired, eligible buyers in rank order", async () => {
    const all = await rows();
    const target = all.find((a) => a.source === "engine");
    if (!target) throw new Error("no engine row");
    const result = await swapCandidates(db, {
      runId,
      supplierId: target.supplierId,
      slot: target.slot,
      excludeBuyerId: target.buyerId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const busy = new Set(all.filter((a) => a.slot === target.slot).map((a) => a.buyerId));
    const paired = new Set(all.filter((a) => a.supplierId === target.supplierId).map((a) => a.buyerId));
    for (const c of result.data) {
      expect(busy.has(c.buyerId)).toBe(false);
      expect(paired.has(c.buyerId)).toBe(false);
      expect(c.countAfter).toBe(c.count + 1);
      expect(c.count).toBe(all.filter((a) => a.buyerId === c.buyerId).length);
    }
    const tier = (c: { buyerRank: number | null; supplierRank: number | null }) =>
      c.buyerRank !== null && c.supplierRank !== null ? 0 : c.buyerRank !== null || c.supplierRank !== null ? 1 : 2;
    const sum = (c: { buyerRank: number | null; supplierRank: number | null }) =>
      (c.buyerRank ?? 0) + (c.supplierRank ?? 0);
    for (let i = 1; i < result.data.length; i++) {
      const prev = result.data[i - 1];
      const cur = result.data[i];
      const ordered =
        tier(prev) < tier(cur) ||
        (tier(prev) === tier(cur) && (sum(prev) < sum(cur) || (sum(prev) === sum(cur) && prev.count <= cur.count)));
      expect(ordered).toBe(true);
    }
  });

  /** Removes every appointment in `slot` for the given suppliers, so they are free then. */
  async function freeSuppliersIn(slot: number, supplierIds: string[]): Promise<Appointment[]> {
    const removed: Appointment[] = [];
    for (const a of (await rows()).filter((r) => r.slot === slot && supplierIds.includes(r.supplierId))) {
      const result = await removeAppointment(
        db,
        { runId, version: await version(), slot, supplierId: a.supplierId, buyerId: a.buyerId },
        seeded.adminId,
      );
      if (!result.ok) throw new Error(result.error.message);
      removed.push(a);
    }
    return removed;
  }

  it("swapCandidates for a buyer's slot lists only free, unpaired, eligible suppliers, and the pick saves", async () => {
    // Every supplier is booked in every slot in the fixture, so free two of them in slot 1.
    const hyatt = supplierNamed("Hyatt Regency Monterey");
    const carmel = supplierNamed("Carmel Valley Ranch");
    const [first] = await freeSuppliersIn(1, [hyatt.id, carmel.id]);
    const buyerId = first.buyerId; // now free in slot 1
    const now = await rows();
    const result = await swapCandidates(db, { runId, buyerId, slot: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paired = new Set(now.filter((a) => a.buyerId === buyerId).map((a) => a.supplierId));
    const ids = result.data.map((c) => c.supplierId);
    expect(ids.length).toBeGreaterThan(0);
    // Only the two freed suppliers can be free in slot 1, and never one the buyer already meets.
    for (const id of ids) expect([hyatt.id, carmel.id]).toContain(id);
    for (const c of result.data) {
      expect(c.kind).toBe("supplier");
      expect(c.buyerId).toBe(buyerId);
      expect(paired.has(c.supplierId)).toBe(false);
      expect(c.count).toBe(now.filter((a) => a.supplierId === c.supplierId).length);
      expect(c.countAfter).toBe(c.count + 1);
    }
    // The supplier the buyer just lost is free and eligible again.
    expect(ids).toContain(first.supplierId);

    const pick = result.data[0];
    const added = await addAppointment(
      db,
      { runId, version: await version(), slot: 1, supplierId: pick.supplierId, buyerId },
      seeded.adminId,
    );
    expect(added.ok).toBe(true);
    const row = (await rows()).find((a) => a.slot === 1 && a.buyerId === buyerId);
    expect(row).toMatchObject({ supplierId: pick.supplierId, source: "manual", pinned: false });
  });

  it("swapCandidates for a buyer's slot applies biztech eligibility and refuses a withdrawn buyer", async () => {
    const delta = supplierNamed("Delta Staging");
    const hyatt = supplierNamed("Hyatt Regency Monterey");
    const optedOut = seeded.buyers.find((b) => !b.biztechOptIn);
    if (!optedOut) throw new Error("fixture needs a buyer not opted in to biztech");
    // Free Delta (business) and Hyatt (hotel) in slot 1, and the opted-out buyer too.
    await freeSuppliersIn(1, [delta.id, hyatt.id]);
    for (const a of (await rows()).filter((r) => r.buyerId === optedOut.id && r.slot === 1)) {
      const removed = await removeAppointment(
        db,
        { runId, version: await version(), slot: 1, supplierId: a.supplierId, buyerId: a.buyerId },
        seeded.adminId,
      );
      if (!removed.ok) throw new Error(removed.error.message);
    }
    const result = await swapCandidates(db, { runId, buyerId: optedOut.id, slot: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.data.map((c) => c.supplierId);
    expect(ids).not.toContain(delta.id);
    expect(result.data.every((c) => c.kind === "supplier" && c.supplierType === "hotel")).toBe(true);

    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, optedOut.id));
    const refused = await swapCandidates(db, { runId, buyerId: optedOut.id, slot: 1 });
    expect(!refused.ok && refused.error.code).toBe("conflict");
  });

  it("replace swaps the buyer and undo restores it, each bumping the version", async () => {
    const { target, pick } = await replaceableRow();
    const v = await version();
    const replaced = await replaceAppointment(
      db,
      {
        runId,
        version: v,
        slot: target.slot,
        supplierId: target.supplierId,
        removeBuyerId: target.buyerId,
        addBuyerId: pick.buyerId,
      },
      seeded.adminId,
    );
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.data.version).toBe(v + 1);
    expect(replaced.data.affected.map((p) => p.personId).sort()).toEqual(
      [target.buyerId, pick.buyerId, target.supplierId].sort(),
    );
    const supplierChange = replaced.data.affected.find((p) => p.type === "supplier");
    expect(supplierChange?.before).toBe(supplierChange?.after);

    let current = await rows();
    const slotRow = current.find((a) => a.slot === target.slot && a.supplierId === target.supplierId);
    expect(slotRow?.buyerId).toBe(pick.buyerId);
    expect(slotRow?.buyerRank).toBe(pick.buyerRank);

    const replaceAudit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.replace" } }, db);
    expect(replaceAudit.rows[0].before).toMatchObject({ buyerId: target.buyerId, slot: target.slot });
    expect(replaceAudit.rows[0].after).toMatchObject({ buyerId: pick.buyerId, slot: target.slot });

    const undone = await undoAudit(db, { auditEventId: replaced.data.auditEventId, adminId: seeded.adminId });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.data.version).toBe(v + 2);
    current = await rows();
    const restored = current.find((a) => a.slot === target.slot && a.supplierId === target.supplierId);
    expect(restored?.buyerId).toBe(target.buyerId);
    expect(restored?.buyerRank).toBe(target.buyerRank);
    expect(restored?.supplierRank).toBe(target.supplierRank);

    const undoAuditRows = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.undo" } }, db);
    expect(undoAuditRows.rows[0].note).toContain(replaced.data.auditEventId);

    const twice = await undoAudit(db, { auditEventId: replaced.data.auditEventId, adminId: seeded.adminId });
    expect(!twice.ok && twice.error.code).toBe("conflict");

    const notUndoable = await undoAudit(db, { auditEventId: undoAuditRows.rows[0].id, adminId: seeded.adminId });
    expect(notUndoable.ok).toBe(true);
  });

  it("a replacement starts unpinned, the audit row says the pin was dropped, and undo puts the pin back", async () => {
    const { target, pick } = await replaceableRow();
    await db.update(appointments).set({ pinned: true }).where(eq(appointments.id, target.id));
    const replaced = await replaceAppointment(
      db,
      {
        runId,
        version: await version(),
        slot: target.slot,
        supplierId: target.supplierId,
        removeBuyerId: target.buyerId,
        addBuyerId: pick.buyerId,
      },
      seeded.adminId,
    );
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const row = (await rows()).find((a) => a.slot === target.slot && a.supplierId === target.supplierId);
    expect(row).toMatchObject({ buyerId: pick.buyerId, pinned: false, source: "manual" });
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.replace" } }, db);
    expect(audit.rows[0].before).toMatchObject({ pinned: true });
    expect(audit.rows[0].after).toMatchObject({ buyerId: pick.buyerId, pinned: false, pinDropped: true });
    expect(audit.rows[0].after).not.toHaveProperty("pinKept");

    const undone = await undoAudit(db, { auditEventId: replaced.data.auditEventId, adminId: seeded.adminId });
    expect(undone.ok).toBe(true);
    const restored = (await rows()).find((a) => a.slot === target.slot && a.supplierId === target.supplierId);
    expect(restored).toMatchObject({ buyerId: target.buyerId, pinned: true });
  });

  it("undoing a removal puts a pinned appointment back pinned", async () => {
    const [first] = await rows();
    await db.update(appointments).set({ pinned: true }).where(eq(appointments.id, first.id));
    const result = await removeAppointment(
      db,
      { runId, version: await version(), slot: first.slot, supplierId: first.supplierId, buyerId: first.buyerId },
      seeded.adminId,
    );
    if (!result.ok) throw new Error(result.error.message);
    const undone = await undoAudit(db, { auditEventId: result.data.auditEventId, adminId: seeded.adminId });
    expect(undone.ok).toBe(true);
    const back = (await rows()).find((a) => a.slot === first.slot && a.supplierId === first.supplierId);
    expect(back).toMatchObject({ buyerId: first.buyerId, pinned: true });
  });

  it("undo refuses other audit actions", async () => {
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "matching.run" } }, db);
    const result = await undoAudit(db, { auditEventId: audit.rows[0].id, adminId: seeded.adminId });
    expect(!result.ok && result.error.code).toBe("validation");
  });
});

describe("desks (D17)", () => {
  it("planDesks is alphabetical and skips override numbers", () => {
    const plan = planDesks(
      seeded.suppliers.map((s) =>
        s.name === "Monterey Plaza Hotel" ? { ...s, deskOverride: true, deskNumber: 2 } : s,
      ),
    );
    expect(plan.map((p) => [p.name, p.desk])).toEqual([
      ["Alpha Audio", 1],
      ["Bravo Lighting", 3],
      ["Carmel Valley Ranch", 4],
      ["Delta Staging", 5],
      ["Hyatt Regency Monterey", 6],
      ["Monterey Plaza Hotel", 2],
    ]);
  });
});

describe("desks for withdrawn suppliers", () => {
  it("planDesks gives a withdrawn supplier no desk, an override included, and frees its number", () => {
    const plan = planDesks(
      seeded.suppliers.map((s) =>
        s.name === "Alpha Audio" ? { ...s, status: "withdrawn" as const, deskOverride: true, deskNumber: 2 } : s,
      ),
    );
    expect(plan.map((p) => [p.name, p.desk, p.override])).toEqual([
      ["Alpha Audio", null, false],
      ["Bravo Lighting", 1, false],
      ["Carmel Valley Ranch", 2, false],
      ["Delta Staging", 3, false],
      ["Hyatt Regency Monterey", 4, false],
      ["Monterey Plaza Hotel", 5, false],
    ]);
  });

  it("reassignDesks clears a withdrawn supplier's override and counts only active desks", async () => {
    const alpha = supplierNamed("Alpha Audio");
    await db
      .update(suppliers)
      .set({ status: "withdrawn", deskOverride: true, deskNumber: 57 })
      .where(eq(suppliers.id, alpha.id));
    const result = await reassignDesks(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.desks.filter((d) => d.desk !== null)).toHaveLength(5);
    expect(result.data.desks.find((d) => d.supplierId === alpha.id)).toMatchObject({ desk: null, override: false });
    const [row] = await db.select().from(suppliers).where(eq(suppliers.id, alpha.id));
    expect(row).toMatchObject({ deskNumber: null, deskOverride: false });
  });
});

describe("lock and unlock", () => {
  it("lock assigns desks, issues tokens, and sets status locked", async () => {
    const plaza = supplierNamed("Monterey Plaza Hotel");
    await db.update(suppliers).set({ deskOverride: true, deskNumber: 2 }).where(eq(suppliers.id, plaza.id));

    const result = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 12 buyers + 6 supplier admins + 3 attendees
    expect(result.data.tokensIssued).toBe(21);
    const tokens = await db.select().from(accessTokens).where(eq(accessTokens.eventId, seeded.eventId));
    expect(tokens).toHaveLength(21);

    const rowsAfter = await db.select().from(suppliers).where(eq(suppliers.eventId, seeded.eventId));
    const desks = Object.fromEntries(rowsAfter.map((s) => [s.name, s.deskNumber]));
    expect(desks).toEqual({
      "Alpha Audio": 1,
      "Bravo Lighting": 3,
      "Carmel Valley Ranch": 4,
      "Delta Staging": 5,
      "Hyatt Regency Monterey": 6,
      "Monterey Plaza Hotel": 2,
    });
    const [event] = await db.select().from(events).where(eq(events.id, seeded.eventId));
    expect(event.status).toBe("locked");

    const again = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(again).toEqual({ ok: false, error: { code: "locked", message: "The schedule is locked. Unlock it on the Schedule page to make changes." } });
  });

  it("lock on an archived event says it is archived, not already locked", async () => {
    await db.update(events).set({ status: "archived" }).where(eq(events.id, seeded.eventId));
    const result = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(result).toEqual({ ok: false, error: { code: "locked", message: "This event is archived and can't be changed." } });
  });

  it("refuses edits and desk changes while locked", async () => {
    await removeOne();
    const locked = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(locked.ok).toBe(true);
    const [a] = await rows();
    const edit = await removeAppointment(
      db,
      { runId, version: await version(), slot: a.slot, supplierId: a.supplierId, buyerId: a.buyerId },
      seeded.adminId,
    );
    expect(!edit.ok && edit.error.code).toBe("locked");
    const desks = await reassignDesks(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(!desks.ok && desks.error.code).toBe("locked");
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.remove" } }, db);
    const undo = await undoAudit(db, { auditEventId: audit.rows[0].id, adminId: seeded.adminId });
    expect(!undo.ok && undo.error.code).toBe("locked");
  });

  it("unlock needs a reason and returns the event to matched", async () => {
    const locked = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(locked.ok).toBe(true);
    const noReason = await unlockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId, reason: "  " });
    expect(!noReason.ok && noReason.error.code).toBe("validation");

    const result = await unlockSchedule(db, {
      eventId: seeded.eventId,
      adminId: seeded.adminId,
      reason: "Supplier asked for a change",
    });
    expect(result.ok).toBe(true);
    const [event] = await db.select().from(events).where(eq(events.id, seeded.eventId));
    expect(event.status).toBe("matched");
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "schedule.unlock" } }, db);
    expect(audit.rows[0].note).toBe("Supplier asked for a change");
    expect(audit.rows[0].before).toEqual({ status: "locked" });

    const notLocked = await unlockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId, reason: "x" });
    expect(!notLocked.ok && notLocked.error.code).toBe("validation");

    const desks = await reassignDesks(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(desks.ok).toBe(true);
  });
});

describe("withdrawn people still on the schedule", () => {
  /** Withdraws the buyer of the first appointment and returns that appointment. */
  async function withdrawFirstBuyer(): Promise<Appointment> {
    const [first] = (await rows()).sort((a, b) => a.slot - b.slot);
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, first.buyerId));
    return first;
  }

  it("getScheduleView flags the appointment and lists it under withdrawn", async () => {
    const first = await withdrawFirstBuyer();
    const view = (await getScheduleView(seeded.eventId, db))!;
    const flagged = view.appointments.filter((a) => a.counterpartWithdrawn);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((a) => a.buyerId === first.buyerId)).toBe(true);
    expect(view.health.withdrawn.map((w) => w.appointmentId).sort()).toEqual(flagged.map((a) => a.id).sort());
    expect(view.health.withdrawn[0].withdrawnIds).toEqual([first.buyerId]);
    expect(view.appointments.filter((a) => a.buyerId !== first.buyerId).every((a) => !a.counterpartWithdrawn)).toBe(true);
  });

  it("loadPersonSchedule shows the participant an OPEN slot", async () => {
    const first = await withdrawFirstBuyer();
    const schedule = (await loadPersonSchedule(db, seeded.eventId, { type: "supplier", id: first.supplierId }))!;
    expect(schedule.slots.find((s) => s.slot === first.slot)!.appointment).toBeNull();
    expect(schedule.slots.some((s) => s.appointment?.counterpartId === first.buyerId)).toBe(false);
  });

  it("lockSchedule refuses until the appointments are gone, and writes nothing", async () => {
    await withdrawFirstBuyer();
    const view = (await getScheduleView(seeded.eventId, db))!;
    const n = view.health.withdrawn.length;
    const refused = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("conflict");
    expect(refused.error.message).toBe(
      n === 1
        ? "1 appointment involves someone who withdrew. Re-run matching keeping existing appointments, or remove it, before locking."
        : `${n} appointments involve someone who withdrew. Re-run matching keeping existing appointments, or remove them, before locking.`,
    );
    const [event] = await db.select().from(events).where(eq(events.id, seeded.eventId));
    expect(event.status).toBe("matched");
    expect(await db.select().from(accessTokens).where(eq(accessTokens.eventId, seeded.eventId))).toHaveLength(0);

    for (const w of view.health.withdrawn) {
      const removed = await removeAppointment(
        db,
        { runId, version: await version(), slot: w.slot, supplierId: w.supplierId, buyerId: w.buyerId },
        seeded.adminId,
      );
      expect(removed.ok).toBe(true);
    }
    expect((await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId })).ok).toBe(true);
  });
});

describe("status races (compare-and-set)", () => {
  const setStatus = (status: "matched" | "locked" | "archived") => () =>
    db.update(events).set({ status }).where(eq(events.id, seeded.eventId));

  it("lock reports locked when another lock lands before its write", async () => {
    const result = await lockSchedule(raceBeforeTransaction(db, setStatus("locked")), {
      eventId: seeded.eventId,
      adminId: seeded.adminId,
    });
    expect(result).toEqual({ ok: false, error: { code: "locked", message: "The schedule is locked. Unlock it on the Schedule page to make changes." } });
    expect(await db.select().from(accessTokens).where(eq(accessTokens.eventId, seeded.eventId))).toHaveLength(0);
    expect((await listAudit({ eventId: seeded.eventId, filters: { action: "schedule.lock" } }, db)).total).toBe(0);
  });

  it("unlock reports archived when an archive lands before its write", async () => {
    expect((await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId })).ok).toBe(true);
    const raced = await unlockSchedule(raceBeforeTransaction(db, setStatus("archived")), {
      eventId: seeded.eventId,
      adminId: seeded.adminId,
      reason: "Late change",
    });
    expect(raced).toEqual({ ok: false, error: { code: "locked", message: "This event is archived and can't be changed." } });
    const [event] = await db.select().from(events).where(eq(events.id, seeded.eventId));
    expect(event.status).toBe("archived");
    expect((await listAudit({ eventId: seeded.eventId, filters: { action: "schedule.unlock" } }, db)).total).toBe(0);
  });

  it("an edit or desk change after a lock reports locked and writes nothing", async () => {
    const [a] = await rows();
    const edit = await removeAppointment(
      raceBeforeTransaction(db, setStatus("locked")),
      { runId, version: await version(), slot: a.slot, supplierId: a.supplierId, buyerId: a.buyerId },
      seeded.adminId,
    );
    expect(edit).toEqual({ ok: false, error: { code: "locked", message: "The schedule is locked. Unlock it on the Schedule page to make changes." } });
    expect((await rows()).some((r) => r.id === a.id)).toBe(true);

    await setStatus("matched")();
    const desks = await reassignDesks(raceBeforeTransaction(db, setStatus("locked")), {
      eventId: seeded.eventId,
      adminId: seeded.adminId,
    });
    expect(!desks.ok && desks.error.code).toBe("locked");
  });
});

describe("only the active run is edited (D33)", () => {
  it("replace, add, remove, and pin refuse once another run is activated", async () => {
    const second = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    if (!second.ok) throw new Error(second.error.message);
    const staleVersion = await version();
    expect((await activateRun(db, { runId: second.data.runId, adminId: seeded.adminId })).ok).toBe(true);

    const [a] = await rows();
    const removed = await removeAppointment(
      db,
      { runId, version: staleVersion, slot: a.slot, supplierId: a.supplierId, buyerId: a.buyerId },
      seeded.adminId,
    );
    expect(removed).toEqual({ ok: false, error: { code: "conflict", message: NOT_ACTIVE_RUN_MESSAGE } });
    const added = await addAppointment(
      db,
      { runId, version: staleVersion, slot: a.slot, supplierId: a.supplierId, buyerId: a.buyerId },
      seeded.adminId,
    );
    expect(!added.ok && added.error.message).toBe(NOT_ACTIVE_RUN_MESSAGE);
    // Any buyer but the one in the slot: replacing a buyer with itself is refused before the run is checked.
    const other = seeded.buyers.find((b) => b.id !== a.buyerId)!;
    const replaced = await replaceAppointment(
      db,
      { runId, version: staleVersion, slot: a.slot, supplierId: a.supplierId, removeBuyerId: a.buyerId, addBuyerId: other.id },
      seeded.adminId,
    );
    expect(!replaced.ok && replaced.error.message).toBe(NOT_ACTIVE_RUN_MESSAGE);
    const pinned = await setPinned(db, { appointmentId: a.id, pinned: true, adminId: seeded.adminId });
    expect(!pinned.ok && pinned.error.message).toBe(NOT_ACTIVE_RUN_MESSAGE);
    expect((await rows()).find((r) => r.id === a.id)?.pinned).toBe(false);
  });

  it("an activation that lands between an edit's read and write makes it a conflict", async () => {
    const second = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    if (!second.ok) throw new Error(second.error.message);
    const [a] = await rows();
    const activate = () =>
      db.transaction(async (tx) => {
        await tx.update(matchRuns).set({ isActive: false }).where(eq(matchRuns.id, runId));
        await tx.update(matchRuns).set({ isActive: true }).where(eq(matchRuns.id, second.data.runId));
      });
    const result = await removeAppointment(
      raceBeforeTransaction(db, activate),
      { runId, version: await version(), slot: a.slot, supplierId: a.supplierId, buyerId: a.buyerId },
      seeded.adminId,
    );
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: NOT_ACTIVE_RUN_MESSAGE } });
  });
});

describe("changes that land between an edit's read and its write", () => {
  /** A replace that is valid when read: an engine row and its best candidate. */
  async function replaceInput() {
    const { target, pick } = await replaceableRow();
    return {
      target,
      pick,
      input: {
        runId,
        version: await version(),
        slot: target.slot,
        supplierId: target.supplierId,
        removeBuyerId: target.buyerId,
        addBuyerId: pick.buyerId,
      },
    };
  }

  async function expectNothingWritten(before: Appointment[], v: number) {
    expect((await rows()).map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(await version()).toBe(v);
  }

  it("a settings save that drops the slot refuses the add", async () => {
    const [last] = (await rows()).filter((r) => r.slot === 9);
    const cleared = await removeAppointment(
      db,
      { runId, version: await version(), slot: 9, supplierId: last.supplierId, buyerId: last.buyerId },
      seeded.adminId,
    );
    if (!cleared.ok) throw new Error(cleared.error.message);
    const before = await rows();
    const v = await version();
    const [event] = await db.select().from(events).where(eq(events.id, seeded.eventId));
    const shrink = () =>
      db
        .update(events)
        .set({ settings: { ...event.settings, slotCount: 8, slots: event.settings.slots.slice(0, 8), supplierTarget: 8 } })
        .where(eq(events.id, seeded.eventId));
    const result = await addAppointment(
      raceBeforeTransaction(db, shrink),
      { runId, version: v, slot: 9, supplierId: last.supplierId, buyerId: last.buyerId },
      seeded.adminId,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "validation", message: "Slot 9 does not exist. This event has 8 slots." },
    });
    await expectNothingWritten(before, v);
  });

  it("a withdrawal of the buyer being booked refuses the replace", async () => {
    const { pick, input } = await replaceInput();
    const before = await rows();
    const withdraw = () => db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, pick.buyerId));
    const result = await replaceAppointment(raceBeforeTransaction(db, withdraw), input, seeded.adminId);
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: `${pick.name} has withdrawn.` } });
    await expectNothingWritten(before, input.version);
  });

  it("a withdrawal of the supplier refuses the replace", async () => {
    const { target, input } = await replaceInput();
    const before = await rows();
    const withdraw = () => db.update(suppliers).set({ status: "withdrawn" }).where(eq(suppliers.id, target.supplierId));
    const result = await replaceAppointment(raceBeforeTransaction(db, withdraw), input, seeded.adminId);
    expect(!result.ok && result.error.message).toMatch(/has withdrawn\.$/);
    await expectNothingWritten(before, input.version);
  });

  it("an import that marks the pair N/A refuses the replace", async () => {
    const { target, pick, input } = await replaceInput();
    const before = await rows();
    const reject = () =>
      db.transaction(async (tx) => {
        await tx
          .delete(rankings)
          .where(
            and(
              eq(rankings.eventId, seeded.eventId),
              eq(rankings.rankerId, pick.buyerId),
              eq(rankings.targetId, target.supplierId),
            ),
          );
        await tx.insert(rankings).values({
          eventId: seeded.eventId,
          rankerType: "buyer",
          rankerId: pick.buyerId,
          targetType: "supplier",
          targetId: target.supplierId,
          rank: null,
          isRejection: true,
        });
      });
    const result = await replaceAppointment(raceBeforeTransaction(db, reject), input, seeded.adminId);
    expect(!result.ok && result.error.code).toBe("conflict");
    expect(!result.ok && result.error.message).toMatch(/ marked .* as N\/A\.$/);
    await expectNothingWritten(before, input.version);
  });

  it("the saved row and stats use what was committed at the write", async () => {
    // A buyer who withdrew in between and is not part of the edit still counts in the stats as withdrawn.
    const { input } = await replaceInput();
    const bystander = seeded.buyers.find((b) => b.id !== input.removeBuyerId && b.id !== input.addBuyerId)!;
    const withdraw = () => db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, bystander.id));
    const result = await replaceAppointment(raceBeforeTransaction(db, withdraw), input, seeded.adminId);
    expect(result.ok).toBe(true);
    const run = await getActiveRun(seeded.eventId, db);
    expect(run?.stats?.totalBuyers).toBe(seeded.buyers.length - 1);
  });
});

describe("undo refused because someone withdrew", () => {
  it("says the change can't be undone and where to restore the buyer", async () => {
    const removed = await removeOne();
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.remove" } }, db);
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, removed.buyerId));
    const view = (await getScheduleView(seeded.eventId, db))!;
    const name = view.buyers.find((b) => b.id === removed.buyerId)!.name;
    const result = await undoAudit(db, { auditEventId: audit.rows[0].id, adminId: seeded.adminId });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "conflict",
        message: `${name} has withdrawn, so this change can't be undone. Restore them on the Participants page first, or leave the slot as it is.`,
      },
    });
  });

  it("points to the Suppliers page for a supplier", async () => {
    const removed = await removeOne();
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.remove" } }, db);
    await db.update(suppliers).set({ status: "withdrawn" }).where(eq(suppliers.id, removed.supplierId));
    const supplier = seeded.suppliers.find((x) => x.id === removed.supplierId)!;
    const result = await undoAudit(db, { auditEventId: audit.rows[0].id, adminId: seeded.adminId });
    expect(!result.ok && result.error.message).toBe(
      `${supplier.name} has withdrawn, so this change can't be undone. Restore them on the Suppliers page first, or leave the slot as it is.`,
    );
  });
});

describe("undo blocked by a later edit", () => {
  it("says what is in the way and what to do", async () => {
    // A meeting to remove, and a hotel desk in the same slot its buyer could take instead.
    // The first and last seeded buyers are left out: one has an N/A, the other no biztech.
    const all = (await rows()).sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
    const plain = new Set(seeded.buyers.slice(1, -1).map((b) => b.id));
    const hotels = new Set(seeded.suppliers.filter((x) => x.type === "hotel").map((x) => x.id));
    const meets = (buyerId: string, supplierId: string) => all.some((r) => r.buyerId === buyerId && r.supplierId === supplierId);
    let pair: { removed: Appointment; other: Appointment } | null = null;
    for (const removed of all.filter((r) => plain.has(r.buyerId))) {
      const other = all.find(
        (r) => r.slot === removed.slot && hotels.has(r.supplierId) && !meets(removed.buyerId, r.supplierId),
      );
      if (other) {
        pair = { removed, other };
        break;
      }
    }
    if (!pair) throw new Error("the fixture has no buyer who can move desks");
    const { removed, other } = pair;

    const removal = await removeAppointment(
      db,
      { runId, version: await version(), slot: removed.slot, supplierId: removed.supplierId, buyerId: removed.buyerId },
      seeded.adminId,
    );
    if (!removal.ok) throw new Error(removal.error.message);
    // Before the removal is undone, the buyer is booked at the other desk in that slot.
    const moved = await replaceAppointment(
      db,
      {
        runId,
        version: await version(),
        slot: other.slot,
        supplierId: other.supplierId,
        removeBuyerId: other.buyerId,
        addBuyerId: removed.buyerId,
      },
      seeded.adminId,
    );
    if (!moved.ok) throw new Error(moved.error.message);

    const result = await undoAudit(db, { auditEventId: removal.data.auditEventId, adminId: seeded.adminId });
    const view = (await getScheduleView(seeded.eventId, db))!;
    const buyer = view.buyers.find((b) => b.id === removed.buyerId)!;
    const supplier = view.suppliers.find((x) => x.id === other.supplierId)!;
    expect(result).toEqual({
      ok: false,
      error: {
        code: "conflict",
        message: `${buyer.name} is already booked in slot ${removed.slot} with ${supplier.name}. ${UNDO_CONFLICT_HINT}`,
      },
    });
  });
});

describe("undo with a version (D11)", () => {
  it("refuses a stale version and accepts the current one", async () => {
    await removeOne();
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.remove" } }, db);
    const current = await version();
    const stale = await undoAudit(db, { auditEventId: audit.rows[0].id, adminId: seeded.adminId, version: current - 1 });
    expect(stale).toEqual({ ok: false, error: { code: "conflict", message: VERSION_CONFLICT_MESSAGE } });
    const fresh = await undoAudit(db, { auditEventId: audit.rows[0].id, adminId: seeded.adminId, version: current });
    expect(fresh.ok).toBe(true);
  });
});

describe("manualChanges", () => {
  it("counts replace, add, and remove saves on the active run, minus undone ones", async () => {
    expect((await getScheduleView(seeded.eventId, db))!.manualChanges).toBe(0);
    const first = await removeOne();
    const second = await removeOne();
    expect((await getScheduleView(seeded.eventId, db))!.manualChanges).toBe(2);

    const removals = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.remove" } }, db);
    const ofSecond = removals.rows.find(
      (r) => (r.before as { buyerId: string }).buyerId === second.buyerId && (r.before as { slot: number }).slot === second.slot,
    )!;
    const undone = await undoAudit(db, { auditEventId: ofSecond.id, adminId: seeded.adminId });
    expect(undone.ok).toBe(true);
    expect((await getScheduleView(seeded.eventId, db))!.manualChanges).toBe(1);

    // Undoing the undo puts the removal back in effect.
    if (!undone.ok) return;
    expect((await undoAudit(db, { auditEventId: undone.data.auditEventId, adminId: seeded.adminId })).ok).toBe(true);
    expect((await getScheduleView(seeded.eventId, db))!.manualChanges).toBe(2);
    expect(first.runId).toBe(runId);

    // Edits on another run don't count once it is not the active one.
    const next = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    if (!next.ok) throw new Error(next.error.message);
    await activateRun(db, { runId: next.data.runId, adminId: seeded.adminId });
    expect((await getScheduleView(seeded.eventId, db))!.manualChanges).toBe(0);
  });
});

describe("unlock while an email send is in progress", () => {
  it("refuses and keeps the schedule locked until the send finishes", async () => {
    const event = await seedEvent(db, { buyers: 4 });
    const run = await startRun(db, { eventId: event.eventId, adminId: event.adminId, keepExisting: false });
    if (!run.ok) throw new Error(run.error.message);
    expect((await lockSchedule(db, { eventId: event.eventId, adminId: event.adminId })).ok).toBe(true);
    const [campaign] = await db
      .insert(emailCampaigns)
      .values({
        eventId: event.eventId,
        name: "Your schedule",
        fromName: "D&A",
        fromEmail: "schedule@example.com",
        replyTo: "staff@example.com",
        subject: "Your schedule",
        htmlBody: "<p>Hi</p>",
        audience: "all",
        kind: "initial",
        status: "sending",
      })
      .returning();
    const input = { eventId: event.eventId, adminId: event.adminId, reason: "Late change" };
    expect(await unlockSchedule(db, input)).toEqual({ ok: false, error: { code: "conflict", message: SEND_IN_PROGRESS_MESSAGE } });
    expect((await db.select().from(events).where(eq(events.id, event.eventId)))[0].status).toBe("locked");
    expect((await listAudit({ eventId: event.eventId, filters: { action: "schedule.unlock" } }, db)).total).toBe(0);

    await db.update(emailCampaigns).set({ status: "sent" }).where(eq(emailCampaigns.id, campaign.id));
    expect((await unlockSchedule(db, input)).ok).toBe(true);
  });
});
