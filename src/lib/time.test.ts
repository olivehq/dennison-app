import { describe, expect, it } from "vitest";
import { buildSlots, formatEventDate, formatMinutes, nowInTimezone, parseClock } from "./time";

describe("formatMinutes", () => {
  it("formats afternoon and morning times on a 12-hour clock", () => {
    expect(formatMinutes(910)).toBe("3:10 PM");
    expect(formatMinutes(0)).toBe("12:00 AM");
    expect(formatMinutes(9 * 60 + 5)).toBe("9:05 AM");
    expect(formatMinutes(12 * 60)).toBe("12:00 PM");
    expect(formatMinutes(23 * 60 + 59)).toBe("11:59 PM");
    expect(formatMinutes(1440)).toBe("12:00 AM");
  });

  it("rejects values outside a day", () => {
    expect(() => formatMinutes(-1)).toThrow(RangeError);
    expect(() => formatMinutes(1441)).toThrow(RangeError);
    expect(() => formatMinutes(10.5)).toThrow(RangeError);
  });
});

describe("parseClock", () => {
  it("reads 12-hour and 24-hour input", () => {
    expect(parseClock("3:10 PM")).toBe(910);
    expect(parseClock("3:10pm")).toBe(910);
    expect(parseClock("12:00 AM")).toBe(0);
    expect(parseClock("12:30 PM")).toBe(750);
    expect(parseClock("15:10")).toBe(910);
    expect(parseClock("3 PM")).toBe(900);
    expect(parseClock(" 9:05 a.m. ")).toBe(545);
  });

  it("returns null for unreadable input", () => {
    expect(parseClock("")).toBeNull();
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("13:00 PM")).toBeNull();
    expect(parseClock("3:60 PM")).toBeNull();
    expect(parseClock("noon")).toBeNull();
  });

  it("round-trips formatMinutes", () => {
    for (const minutes of [0, 1, 59, 60, 719, 720, 721, 910, 1439]) {
      expect(parseClock(formatMinutes(minutes))).toBe(minutes);
    }
  });
});

describe("buildSlots", () => {
  it("reproduces the 2025 show: nine 10-minute slots, 11 minutes apart, 3:10 to 4:48 PM", () => {
    const slots = buildSlots({ count: 9, firstStartMinutes: 910, durationMinutes: 10, gapMinutes: 1 });
    expect(slots).toHaveLength(9);
    expect(slots[0]).toEqual({ n: 1, startMinutes: 910, endMinutes: 920 });
    expect(slots[8]).toEqual({ n: 9, startMinutes: 998, endMinutes: 1008 });
    expect(formatMinutes(slots[8].endMinutes)).toBe("4:48 PM");
  });

  it("rejects slots that run past midnight", () => {
    expect(() =>
      buildSlots({ count: 3, firstStartMinutes: 1400, durationMinutes: 30, gapMinutes: 0 }),
    ).toThrow(RangeError);
  });
});

describe("formatEventDate", () => {
  it("prints the calendar date without shifting it across timezones", () => {
    expect(formatEventDate("2026-11-10", "America/Los_Angeles")).toBe("Tuesday, November 10, 2026");
    expect(formatEventDate("2026-11-10", "Pacific/Auckland")).toBe("Tuesday, November 10, 2026");
  });

  it("rejects non-ISO input", () => {
    expect(() => formatEventDate("11/10/2026", "UTC")).toThrow(RangeError);
  });
});

describe("nowInTimezone", () => {
  it("returns minutes from midnight in the event timezone, not the machine's", () => {
    const instant = new Date("2026-11-10T23:10:00Z");
    expect(nowInTimezone("America/Los_Angeles", instant)).toBe(15 * 60 + 10);
    expect(nowInTimezone("America/New_York", instant)).toBe(18 * 60 + 10);
    expect(nowInTimezone("UTC", instant)).toBe(23 * 60 + 10);
  });
});
