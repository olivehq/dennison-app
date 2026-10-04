import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { accessTokens, appointments, events, suppliers, type Appointment } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { listAudit } from "@/server/audit/audit";
import { getActiveRun } from "@/server/matching/queries";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import {
  addAppointment,
  removeAppointment,
  replaceAppointment,
  swapCandidates,
  undoAudit,
  VERSION_CONFLICT_MESSAGE,
  type SwapCandidate,
} from "./edits";
import { lockSchedule, planDesks, reassignDesks, unlockSchedule } from "./lock";
import { getPersonSchedule, getScheduleView } from "./queries";

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

  it("getPersonSchedule shows OPEN gaps and hides ranks for participants", async () => {
    const buyer = seeded.buyers[0];
    const mine = (await rows()).filter((a) => a.buyerId === buyer.id);
    const admin = await getPersonSchedule(seeded.eventId, { type: "buyer", id: buyer.id }, db);
    expect(admin?.slots).toHaveLength(9);
    expect(admin?.slots.filter((s) => s.appointment !== null)).toHaveLength(mine.length);
    expect(admin?.slots.filter((s) => s.appointment === null).length).toBe(9 - mine.length);
    const booked = admin?.slots.find((s) => s.appointment !== null);
    expect(booked?.appointment).toHaveProperty("buyerRank");

    const participant = await getPersonSchedule(
      seeded.eventId,
      { type: "buyer", id: buyer.id, forParticipant: true },
      db,
    );
    for (const slot of participant?.slots ?? []) {
      if (!slot.appointment) continue;
      expect(slot.appointment).not.toHaveProperty("buyerRank");
      expect(slot.appointment).not.toHaveProperty("supplierRank");
      expect(slot.appointment).not.toHaveProperty("strength");
      expect(slot.appointment.counterpartName).not.toBe("");
    }

    const supplier = await getPersonSchedule(seeded.eventId, { type: "supplier", id: seeded.suppliers[0].id }, db);
    expect(supplier?.slots.every((s) => s.appointment !== null)).toBe(true);
    expect(await getPersonSchedule(seeded.eventId, { type: "buyer", id: seeded.suppliers[0].id }, db)).toBeNull();
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

  it("replace keeps the slot's pin and says so in the audit row", async () => {
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
    expect(row).toMatchObject({ buyerId: pick.buyerId, pinned: true });
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.replace" } }, db);
    expect(audit.rows[0].before).toMatchObject({ pinned: true });
    expect(audit.rows[0].after).toMatchObject({ buyerId: pick.buyerId, pinned: true, pinKept: true });

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
    expect(!again.ok && again.error.code).toBe("conflict");
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
