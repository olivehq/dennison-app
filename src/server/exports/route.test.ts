import { desc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { auditEvents, matchRuns } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { getSession } from "@/server/auth/session";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { exportRoute } from "./http";
import { suppliersFullCsv } from "./roster";

vi.mock("@/server/auth/session", () => ({ getSession: vi.fn() }));

let db: Db;
let seeded: Seeded;

const params = () => Promise.resolve({ eventId: seeded.eventId });

async function lastAudit(action: string) {
  const [row] = await db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(desc(auditEvents.createdAt)).limit(1);
  return row;
}

beforeAll(async () => {
  db = await createTestDb();
  seeded = await seedEvent(db);
});

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ user: { id: seeded.adminId } } as Awaited<ReturnType<typeof getSession>>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportRoute", () => {
  it("serves the roster lists with no active run and audits against the event", async () => {
    const response = await exportRoute("suppliers_full", params(), async ({ event }) => {
      const result = await suppliersFullCsv(event.id);
      if (!result.ok) throw new Error("no roster");
      return { body: result.data.csv, details: { rows: result.data.count } };
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="AW_2026_Suppliers_Full.csv"');
    const audit = await lastAudit("export.suppliers_full");
    expect(audit.entityType).toBe("event");
    expect(audit.after).toMatchObject({ rows: expect.any(Number) });
  });

  it("refuses a run-based export with the existing 409 when no run is active", async () => {
    const build = vi.fn();
    const response = await exportRoute("master", params(), build);
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("There is no active schedule yet. Run matching and activate a run first.");
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses without a session or for an unknown event", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    expect((await exportRoute("master", params(), vi.fn())).status).toBe(401);
    const missing = Promise.resolve({ eventId: "00000000-0000-4000-8000-000000000000" });
    expect((await exportRoute("master", missing, vi.fn())).status).toBe(404);
    expect((await exportRoute("master", Promise.resolve({ eventId: "nope" }), vi.fn())).status).toBe(404);
  });

  it("audits the run id and version of the view the file was built from", async () => {
    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    expect(run.ok).toBe(true);
    const [active] = await db.select().from(matchRuns).where(eq(matchRuns.eventId, seeded.eventId));

    const response = await exportRoute("master", params(), async (_context, view) => {
      expect(view.run.id).toBe(active.id);
      // The schedule changes while the file is being built. The audit row must still name the version the file used.
      await db.update(matchRuns).set({ version: view.run.version + 5 }).where(eq(matchRuns.id, view.run.id));
      return { body: "csv", details: { rows: view.appointments.length } };
    });
    expect(response.status).toBe(200);
    const audit = await lastAudit("export.master");
    expect(audit.after).toMatchObject({ runId: active.id, runVersion: active.version, rows: expect.any(Number) });
  });

  it("passes a refusal from the builder through without an audit row", async () => {
    const before = await db.select().from(auditEvents).where(eq(auditEvents.action, "export.report"));
    const response = await exportRoute("report", params(), async () => new Response("no stats", { status: 409 }));
    expect(response.status).toBe(409);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "export.report"))).toHaveLength(before.length);
  });

  it("answers 500 without the error text when the builder throws, and logs only the error type", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await exportRoute("master", params(), async () => {
      throw new Error("insert failed for jane@example.com token=abc123");
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toMatch(/jane|abc123|insert failed/);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]);
    expect(logged).toContain("master");
    expect(logged).not.toMatch(/jane|abc123|insert failed/);
  });
});
