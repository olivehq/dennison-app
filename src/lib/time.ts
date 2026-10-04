import { TZDate } from "@date-fns/tz";
import { addDays, endOfDay, format } from "date-fns";

export const MINUTES_PER_DAY = 24 * 60;

export type Slot = {
  n: number;
  startMinutes: number;
  endMinutes: number;
};

function assertMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new RangeError(`Minutes from midnight must be 0..${MINUTES_PER_DAY}, got ${minutes}`);
  }
}

/** 910 -> "3:10 PM". 1440 is treated as midnight at the end of the day. */
export function formatMinutes(minutes: number): string {
  assertMinutes(minutes);
  const wrapped = minutes % MINUTES_PER_DAY;
  const hours24 = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  const suffix = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

/** "3:10 PM" -> 910. Accepts "3:10pm", "15:10", "3 PM". Returns null when unreadable. */
export function parseClock(text: string): number | null {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*$/i.exec(text);
  if (!match) return null;
  let hours = Number(match[1]);
  const mins = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
  if (mins > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = hours % 12;
    if (meridiem === "pm") hours += 12;
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + mins;
}

export function buildSlots(input: {
  count: number;
  firstStartMinutes: number;
  durationMinutes: number;
  gapMinutes: number;
}): Slot[] {
  const { count, firstStartMinutes, durationMinutes, gapMinutes } = input;
  if (!Number.isInteger(count) || count < 1) throw new RangeError("count must be a positive integer");
  if (durationMinutes < 1) throw new RangeError("durationMinutes must be at least 1");
  if (gapMinutes < 0) throw new RangeError("gapMinutes cannot be negative");
  assertMinutes(firstStartMinutes);
  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const startMinutes = firstStartMinutes + i * (durationMinutes + gapMinutes);
    const endMinutes = startMinutes + durationMinutes;
    assertMinutes(endMinutes);
    slots.push({ n: i + 1, startMinutes, endMinutes });
  }
  return slots;
}

/** "2026-11-10", "America/Los_Angeles" -> "Tuesday, November 10, 2026". */
export function formatEventDate(date: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Expected an ISO date (YYYY-MM-DD), got "${date}"`);
  const [, year, month, day] = match;
  const local = new TZDate(Number(year), Number(month) - 1, Number(day), timezone);
  return format(local, "EEEE, MMMM d, yyyy");
}

/** Minutes from midnight right now in the given timezone. `now` is injectable for tests. */
export function nowInTimezone(timezone: string, now: Date = new Date()): number {
  const local = new TZDate(now, timezone);
  return local.getHours() * 60 + local.getMinutes();
}

/** A stored instant shown in the event's timezone: "Nov 10, 2026, 3:10 PM". */
export function formatTimestamp(instant: Date, timezone: string): string {
  return format(new TZDate(instant, timezone), "MMM d, yyyy, h:mm a");
}

/**
 * The last millisecond of `date` plus `days` in the given timezone, as an instant.
 * "2026-11-10", "America/Los_Angeles", 60 -> 2027-01-10T07:59:59.999Z.
 */
export function endOfDayInTimezone(date: string, timezone: string, days = 0): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Expected an ISO date (YYYY-MM-DD), got "${date}"`);
  const [, year, month, day] = match;
  const local = new TZDate(Number(year), Number(month) - 1, Number(day), timezone);
  return new Date(endOfDay(addDays(local, days)).getTime());
}
