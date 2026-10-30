import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "@/server/audit/queries";
import { activityQuery, emptyActivityText, entryTone, groupByDay, isFiltered, summaryStats } from "./activity-view";

const summary: ActivitySummary = {
  today: "2026-11-10",
  yesterday: "2026-11-09",
  changes: 18,
  scheduleEdits: 6,
  imports: 0,
  admins: [{ id: "a1", name: "Demo Admin" }],
};

describe("activityQuery", () => {
  it("keeps the URL names, drops empty filters, and adds the page after the first", () => {
    expect(activityQuery({})).toBe("");
    expect(activityQuery({ type: "schedule", from: "2026-11-10" }, 2)).toBe("?type=schedule&from=2026-11-10&page=2");
    expect(isFiltered({ person: undefined })).toBe(false);
    expect(isFiltered({ admin: "a1" })).toBe(true);
  });
});

describe("summaryStats", () => {
  it("makes each number a shortcut to the log it counts", () => {
    const stats = summaryStats(summary, {});
    expect(stats.map((s) => [s.key, s.value, s.label])).toEqual([
      ["changes", 18, "changes today"],
      ["schedule", 6, "schedule edits today"],
      ["imports", 0, "import changes today"],
      ["admins", 1, "admin active today"],
    ]);
    expect(stats[0].filters).toEqual({ from: "2026-11-10", to: "2026-11-10" });
    expect(stats[1].filters).toEqual({ from: "2026-11-10", to: "2026-11-10", type: "schedule" });
    // Nothing to open for a zero.
    expect(stats[2].filters).toBeNull();
    expect(stats[3].filters).toEqual({ from: "2026-11-10", to: "2026-11-10", admin: "a1" });
    expect(stats.some((s) => s.active)).toBe(false);
  });

  it("marks the stat whose filter is showing", () => {
    const stats = summaryStats(summary, { type: "schedule", from: "2026-11-10", to: "2026-11-10" });
    expect(stats.filter((s) => s.active).map((s) => s.key)).toEqual(["schedule"]);
  });

  it("offers a choice of admin when more than one was active", () => {
    const two = { ...summary, admins: [{ id: "a1", name: "Ann" }, { id: "a2", name: "Bo" }] };
    const admins = summaryStats(two, { admin: "a2", from: "2026-11-10", to: "2026-11-10" })[3];
    expect(admins).toMatchObject({ value: 2, label: "admins active today", filters: null, active: true });
    expect(admins.choices?.map((c) => [c.label, c.filters.admin, c.active])).toEqual([
      ["Ann", "a1", false],
      ["Bo", "a2", true],
    ]);
  });
});

describe("groupByDay", () => {
  it("labels today and yesterday and keeps the order", () => {
    const rows = [
      { id: "1", day: "2026-11-10" },
      { id: "2", day: "2026-11-10" },
      { id: "3", day: "2026-11-09" },
      { id: "4", day: "2026-11-03" },
    ];
    expect(groupByDay(rows, summary, "America/Los_Angeles").map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Today", ["1", "2"]],
      ["Yesterday", ["3"]],
      ["Tuesday, November 3, 2026", ["4"]],
    ]);
  });
});

describe("entryTone", () => {
  it("tints by area, and removals in the destructive tone whatever the area", () => {
    expect(entryTone({ action: "appointment.replace", area: "schedule" })).toBe("schedule");
    expect(entryTone({ action: "matching.run", area: "matching" })).toBe("schedule");
    expect(entryTone({ action: "import.apply", area: "imports" })).toBe("imports");
    expect(entryTone({ action: "appointment.remove", area: "schedule" })).toBe("removal");
    expect(entryTone({ action: "participant.withdraw", area: "roster" })).toBe("removal");
    expect(entryTone({ action: "event.settings", area: "settings" })).toBe("quiet");
    expect(entryTone({ action: "admin.invite_revoke", area: null })).toBe("removal");
  });
});

describe("emptyActivityText", () => {
  it("tells an empty log from a filtered one, and calls out a backwards date range", () => {
    expect(emptyActivityText({}).title).toBe("No changes yet");
    expect(emptyActivityText({ type: "schedule" })).toEqual({
      title: "No changes match these filters",
      description: "Clear a filter or widen the dates.",
    });
    expect(emptyActivityText({ from: "2026-10-30", to: "2026-10-29" }).description).toBe(
      "The From date is after the To date. Swap them or clear one.",
    );
    expect(emptyActivityText({ from: "2026-10-29", to: "2026-10-29" }).description).toBe("Clear a filter or widen the dates.");
  });
});
