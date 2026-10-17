import { describe, expect, it } from "vitest";
import type { EventStatus } from "@/lib/schemas/event";
import { orderEvents } from "./event-order";

// Noon UTC on Oct 17, 2026: still Oct 17 in Los Angeles and in Tokyo (9 PM).
const NOW = new Date("2026-10-17T12:00:00Z");

function event(name: string, eventDate: string, status: EventStatus = "draft", timezone = "America/Los_Angeles") {
  return { name, eventDate, status, timezone };
}

describe("orderEvents", () => {
  it("puts upcoming shows first, soonest first, then past open shows, then archived", () => {
    const ordered = orderEvents(
      [
        event("Archived old", "2024-11-10", "archived"),
        event("Past recent", "2026-09-01", "sent"),
        event("Upcoming later", "2027-03-01"),
        event("Archived recent", "2025-11-10", "archived"),
        event("Upcoming soon", "2026-11-10", "matched"),
        event("Past old", "2025-05-01", "locked"),
      ],
      NOW,
    );
    expect(ordered.map((e) => e.name)).toEqual([
      "Upcoming soon",
      "Upcoming later",
      "Past recent",
      "Past old",
      "Archived recent",
      "Archived old",
    ]);
  });

  it("counts a show today as upcoming and an archived future show as archived", () => {
    const ordered = orderEvents(
      [event("Future but archived", "2027-01-01", "archived"), event("Yesterday", "2026-10-16"), event("Today", "2026-10-17")],
      NOW,
    );
    expect(ordered.map((e) => e.name)).toEqual(["Today", "Yesterday", "Future but archived"]);
  });

  it("reads today in each event's own timezone", () => {
    // 11 PM on Oct 16 in Los Angeles is already Oct 17 in Tokyo.
    const lateEvening = new Date("2026-10-17T06:00:00Z");
    const ordered = orderEvents(
      [event("Tokyo show", "2026-10-16", "draft", "Asia/Tokyo"), event("LA show", "2026-10-16")],
      lateEvening,
    );
    expect(ordered.map((e) => e.name)).toEqual(["LA show", "Tokyo show"]);
  });

  it("breaks date ties by name with numbers in order", () => {
    const ordered = orderEvents([event("Show 10", "2026-11-10"), event("show 2", "2026-11-10"), event("Show 1", "2026-11-10")], NOW);
    expect(ordered.map((e) => e.name)).toEqual(["Show 1", "show 2", "Show 10"]);
  });

  it("does not change the input", () => {
    const input = [event("B", "2026-12-01"), event("A", "2026-11-01")];
    orderEvents(input, NOW);
    expect(input.map((e) => e.name)).toEqual(["B", "A"]);
  });
});
