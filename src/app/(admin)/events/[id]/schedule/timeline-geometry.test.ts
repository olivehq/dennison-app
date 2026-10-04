import { describe, expect, it } from "vitest";
import {
  changeovers,
  clockParts,
  dateInTimezone,
  finishedThrough,
  focusSlotAt,
  initialNow,
  minuteAtFraction,
  minutesToPercent,
  nextSlotStart,
  phaseAt,
  playStep,
  prevSlotStart,
  rangeToPercent,
  slotAtMinute,
  stepNow,
  timelineSpan,
} from "./timeline-geometry";

// The 2025 afternoon: nine 10-minute slots from 3:10 PM with 1-minute changeovers.
const SLOTS = Array.from({ length: 9 }, (_, i) => ({
  slot: i + 1,
  startMinutes: 910 + i * 11,
  endMinutes: 920 + i * 11,
}));
const SPAN = timelineSpan(SLOTS);

describe("timelineSpan", () => {
  it("runs from the first start to the last end", () => {
    expect(SPAN).toEqual({ start: 910, end: 1008, length: 98 });
  });

  it("is empty for no slots", () => {
    expect(timelineSpan([])).toEqual({ start: 0, end: 0, length: 0 });
  });
});

describe("percent geometry", () => {
  it("maps the ends of the afternoon to 0 and 100", () => {
    expect(minutesToPercent(910, SPAN)).toBe(0);
    expect(minutesToPercent(1008, SPAN)).toBe(100);
  });

  it("clamps minutes outside the afternoon", () => {
    expect(minutesToPercent(800, SPAN)).toBe(0);
    expect(minutesToPercent(1200, SPAN)).toBe(100);
  });

  it("gives a block its left and width at true minutes", () => {
    const { left, width } = rangeToPercent(921, 931, SPAN);
    expect(left).toBeCloseTo((11 / 98) * 100);
    expect(width).toBeCloseTo((10 / 98) * 100);
  });

  it("turns a pointer fraction back into a whole minute", () => {
    expect(minuteAtFraction(0, SPAN)).toBe(910);
    expect(minuteAtFraction(0.5, SPAN)).toBe(959);
    expect(minuteAtFraction(1.4, SPAN)).toBe(1008);
  });

  it("returns 0 for an empty span", () => {
    expect(minutesToPercent(5, timelineSpan([]))).toBe(0);
  });
});

describe("phaseAt and slotAtMinute", () => {
  it("is before the first slot", () => {
    expect(phaseAt(900, SLOTS)).toEqual({ phase: "before", next: SLOTS[0] });
    expect(slotAtMinute(900, SLOTS)).toBeNull();
  });

  it("is inside a slot with minutes in and to go", () => {
    expect(phaseAt(947, SLOTS)).toEqual({ phase: "in", slot: SLOTS[3], minutesIn: 4, minutesLeft: 6 });
    expect(slotAtMinute(947, SLOTS)).toBe(4);
  });

  it("treats a slot end as the changeover, not the slot", () => {
    expect(phaseAt(920, SLOTS)).toEqual({ phase: "gap", slot: SLOTS[0], next: SLOTS[1] });
    expect(slotAtMinute(920, SLOTS)).toBeNull();
  });

  it("is after the last slot ends", () => {
    expect(phaseAt(1008, SLOTS)).toEqual({ phase: "after" });
  });
});

describe("focusSlotAt", () => {
  it("picks the live slot, the next one in a changeover, the first before, the last after", () => {
    expect(focusSlotAt(947, SLOTS)).toBe(4);
    expect(focusSlotAt(920, SLOTS)).toBe(2);
    expect(focusSlotAt(800, SLOTS)).toBe(1);
    expect(focusSlotAt(1100, SLOTS)).toBe(9);
    expect(focusSlotAt(900, [])).toBeNull();
  });
});

describe("slot stepping", () => {
  it("finds the next and previous slot starts", () => {
    expect(nextSlotStart(947, SLOTS, SPAN)).toBe(954);
    expect(prevSlotStart(947, SLOTS, SPAN)).toBe(943);
    expect(prevSlotStart(943, SLOTS, SPAN)).toBe(932);
  });

  it("stops at the ends of the afternoon", () => {
    expect(nextSlotStart(1000, SLOTS, SPAN)).toBe(1008);
    expect(prevSlotStart(910, SLOTS, SPAN)).toBe(910);
  });

  it("handles the now handle keys", () => {
    expect(stepNow(947, "ArrowRight", false, SLOTS, SPAN)).toBe(948);
    expect(stepNow(947, "ArrowLeft", false, SLOTS, SPAN)).toBe(946);
    expect(stepNow(947, "ArrowRight", true, SLOTS, SPAN)).toBe(954);
    expect(stepNow(947, "ArrowLeft", true, SLOTS, SPAN)).toBe(943);
    expect(stepNow(947, "Home", false, SLOTS, SPAN)).toBe(910);
    expect(stepNow(947, "End", false, SLOTS, SPAN)).toBe(1008);
    expect(stepNow(910, "ArrowLeft", false, SLOTS, SPAN)).toBe(910);
    expect(stepNow(947, "a", false, SLOTS, SPAN)).toBeNull();
  });
});

describe("changeovers and finishedThrough", () => {
  it("lists every 1-minute changeover", () => {
    const gaps = changeovers(SLOTS);
    expect(gaps).toHaveLength(8);
    expect(gaps[0]).toEqual({ start: 920, end: 921 });
  });

  it("has no changeovers when slots touch", () => {
    expect(changeovers([{ slot: 1, startMinutes: 0, endMinutes: 10 }, { slot: 2, startMinutes: 10, endMinutes: 20 }])).toEqual([]);
  });

  it("reports the end of the last finished slot", () => {
    expect(finishedThrough(915, SLOTS)).toBeNull();
    expect(finishedThrough(920, SLOTS)).toBe(920);
    expect(finishedThrough(947, SLOTS)).toBe(942);
  });
});

describe("initialNow", () => {
  it("uses the live time on the show day, clamped to the afternoon", () => {
    expect(initialNow({ eventDate: "2026-11-10", today: "2026-11-10", liveMinutes: 947, span: SPAN })).toEqual({
      minute: 947,
      live: true,
    });
    expect(initialNow({ eventDate: "2026-11-10", today: "2026-11-10", liveMinutes: 600, span: SPAN })).toEqual({
      minute: 910,
      live: true,
    });
  });

  it("starts at the first slot on any other day", () => {
    expect(initialNow({ eventDate: "2026-11-10", today: "2026-10-04", liveMinutes: 947, span: SPAN })).toEqual({
      minute: 910,
      live: false,
    });
  });
});

describe("playStep", () => {
  it("steps a minute, or a slot with reduced motion, and stops at the end", () => {
    expect(playStep(947, false, SLOTS, SPAN)).toBe(948);
    expect(playStep(947, true, SLOTS, SPAN)).toBe(954);
    expect(playStep(1008, false, SLOTS, SPAN)).toBeNull();
  });
});

describe("clockParts", () => {
  it("splits the readout", () => {
    expect(clockParts(947)).toEqual({ time: "3:47", meridiem: "PM" });
    expect(clockParts(0)).toEqual({ time: "12:00", meridiem: "AM" });
    expect(clockParts(720)).toEqual({ time: "12:00", meridiem: "PM" });
  });
});

describe("dateInTimezone", () => {
  it("gives the calendar date in the event timezone, not the machine's", () => {
    const instant = new Date("2026-11-11T02:00:00Z");
    expect(dateInTimezone("America/Los_Angeles", instant)).toBe("2026-11-10");
    expect(dateInTimezone("Europe/London", instant)).toBe("2026-11-11");
  });
});
