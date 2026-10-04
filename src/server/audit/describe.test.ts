import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_GROUPS, describeAudit, isAuditActionGroup, type DescribableAudit } from "./describe";

const BUYER = "b0000000-0000-4000-8000-000000000001";
const OTHER_BUYER = "b0000000-0000-4000-8000-000000000002";
const SUPPLIER = "50000000-0000-4000-8000-000000000001";
const RUN = "a0000000-0000-4000-8000-000000000001";

const names = new Map([
  [BUYER, "CA Medical Association"],
  [OTHER_BUYER, "Visit Berkeley"],
  [SUPPLIER, "Hyatt Regency Monterey"],
]);

function row(action: string, fields: Partial<DescribableAudit> = {}): DescribableAudit {
  return { action, entityType: action.split(".")[0], entityId: null, before: null, after: null, note: null, ...fields };
}

const snap = (buyerId: string, extra: Record<string, unknown> = {}) => ({
  runId: RUN,
  slot: 4,
  buyerId,
  supplierId: SUPPLIER,
  buyerRank: 3,
  supplierRank: null,
  source: "manual",
  pinned: false,
  ...extra,
});

describe("describeAudit", () => {
  it("describes schedule edits with names and the slot", () => {
    expect(describeAudit(row("appointment.replace", { before: snap(BUYER), after: snap(OTHER_BUYER) }), names)).toBe(
      "Replaced CA Medical Association with Visit Berkeley at Hyatt Regency Monterey, slot 4",
    );
    expect(
      describeAudit(row("appointment.replace", { before: snap(BUYER), after: snap(OTHER_BUYER, { pinned: true, pinKept: true }) }), names),
    ).toBe("Replaced CA Medical Association with Visit Berkeley at Hyatt Regency Monterey, slot 4. The pin stays");
    expect(describeAudit(row("appointment.add", { after: snap(BUYER) }), names)).toBe(
      "Added CA Medical Association at Hyatt Regency Monterey, slot 4",
    );
    expect(describeAudit(row("appointment.remove", { before: snap(BUYER) }), names)).toBe(
      "Removed CA Medical Association from Hyatt Regency Monterey, slot 4",
    );
    expect(describeAudit(row("appointment.pin", { after: { pinned: true, slot: 2, buyerId: BUYER, supplierId: SUPPLIER } }), names)).toBe(
      "Pinned CA Medical Association at Hyatt Regency Monterey, slot 2",
    );
  });

  it("says which kind of change an undo reversed", () => {
    expect(describeAudit(row("appointment.undo", { before: snap(OTHER_BUYER), after: snap(BUYER) }), names)).toBe(
      "Undid a change: put CA Medical Association back at Hyatt Regency Monterey, slot 4 in place of Visit Berkeley",
    );
    expect(describeAudit(row("appointment.undo", { after: snap(BUYER) }), names)).toBe(
      "Undid a removal: put CA Medical Association back at Hyatt Regency Monterey, slot 4",
    );
    expect(describeAudit(row("appointment.undo", { before: snap(BUYER) }), names)).toBe(
      "Undid an addition: removed CA Medical Association from Hyatt Regency Monterey, slot 4",
    );
  });

  it("falls back to generic nouns for people no longer on the roster", () => {
    expect(describeAudit(row("appointment.remove", { before: snap("gone") }), new Map())).toBe("Removed a buyer from a supplier, slot 4");
    expect(describeAudit(row("appointment.replace", { before: "garbage", after: 7 }), names)).toBe(
      "Replaced a buyer with a buyer at a supplier, slot ?",
    );
  });

  it("describes lock, unlock, desks, and matching", () => {
    expect(describeAudit(row("schedule.lock", { after: { status: "locked", tokensIssued: 121 } }), names)).toBe(
      "Locked the schedule and assigned desks. Issued 121 new participant links",
    );
    expect(describeAudit(row("schedule.unlock", { note: "Supplier asked for a change" }), names)).toBe(
      "Unlocked the schedule: Supplier asked for a change",
    );
    expect(
      describeAudit(
        row("schedule.reassign_desks", {
          before: { desks: [{ supplierId: "x", desk: 1 }, { supplierId: "y", desk: 2 }] },
          after: { desks: [{ supplierId: "x", desk: 2 }, { supplierId: "y", desk: 1 }] },
        }),
        names,
      ),
    ).toBe("Reassigned desks alphabetically. 2 desks changed");
    expect(
      describeAudit(
        row("matching.run", { after: { status: "completed", keepExisting: true, pinnedCount: 500, appointments: 504, warningCount: 1, isActive: false } }),
        names,
      ),
    ).toBe("Re-ran matching keeping 500 existing appointments, 504 appointments, 1 warning");
    expect(describeAudit(row("matching.run", { after: { status: "completed", appointments: 504, warningCount: 0, isActive: true } }), names)).toBe(
      "Ran matching, 504 appointments. It became the active run",
    );
    expect(describeAudit(row("matching.run", { after: { status: "failed", error: "boom" } }), names)).toBe("Matching failed: boom");
  });

  it("describes roster, links, imports, and settings", () => {
    expect(describeAudit(row("participant.withdraw", { entityId: BUYER }), names)).toBe("Withdrew CA Medical Association");
    expect(describeAudit(row("participant.create", { entityId: "new", after: { firstName: "Ana", lastName: "Ruiz" } }), names)).toBe(
      "Added participant Ana Ruiz",
    );
    expect(describeAudit(row("participant.biztech_opt_in", { entityId: BUYER, after: { biztechOptIn: false } }), names)).toBe(
      "Opted CA Medical Association out of biztech",
    );
    expect(describeAudit(row("supplier.desk", { entityId: SUPPLIER, after: { deskNumber: 12, deskOverride: true } }), names)).toBe(
      "Set Hyatt Regency Monterey to desk 12 (kept at lock)",
    );
    expect(describeAudit(row("token.revoke", { after: { contactType: "buyer", entityId: BUYER } }), names)).toBe(
      "Revoked the link for CA Medical Association",
    );
    expect(describeAudit(row("import.create", { after: { kind: "supplier_rankings", fileName: "ratings.xlsx" } }), names)).toBe(
      "Uploaded ratings.xlsx (supplier rankings)",
    );
    expect(describeAudit(row("import.apply", { after: { status: "applied", kind: "buyer_hotel_rankings", rankingsWritten: 900 } }), names)).toBe(
      "Applied the buyer hotel rankings import, 900 rankings written",
    );
    expect(describeAudit(row("alias.save", { after: { raw: "Hyatt Monterey", entityId: SUPPLIER } }), names)).toBe(
      'Matched the name "Hyatt Monterey" to Hyatt Regency Monterey',
    );
    expect(describeAudit(row("event.settings", { before: { buyerMin: 7, slots: [1] }, after: { buyerMin: 6, slots: [2] } }), names)).toBe(
      "Changed the settings: slot times and buyer minimum",
    );
    expect(describeAudit(row("event.retention", { after: { retainData: true } }), names)).toBe(
      "Turned on keeping participant data after 90 days",
    );
    expect(
      describeAudit(row("event.retention_delete", { after: { deleted: { participants: 65, suppliers: 56 } } }), names),
    ).toBe("Deleted participant data 90 days after the event: 65 participants and 56 suppliers and their schedules");
  });

  it("describes exports and email, and humanises anything unknown", () => {
    expect(describeAudit(row("export.access_list", { after: { runId: RUN } }), names)).toBe("Downloaded the participant access list");
    expect(describeAudit(row("email.send", { after: { name: "Your schedule", sent: 120, failed: 1 } }), names)).toBe(
      'Sent "Your schedule" to 120 recipients, 1 failed',
    );
    expect(describeAudit(row("email.test", { after: { toEmail: "me@example.com" } }), names)).toBe(
      "Sent a test of an email to me@example.com",
    );
    expect(describeAudit(row("something.new_thing"), names)).toBe("Something new thing");
  });
});

describe("AUDIT_ACTION_GROUPS", () => {
  it("covers each group the activity filter offers", () => {
    expect(Object.keys(AUDIT_ACTION_GROUPS)).toEqual(["schedule", "roster", "imports", "matching", "lock", "emails", "exports"]);
    expect(isAuditActionGroup("lock")).toBe(true);
    expect(isAuditActionGroup("toString")).toBe(false);
  });
});
