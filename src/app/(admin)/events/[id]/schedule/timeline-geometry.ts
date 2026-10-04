/**
 * Pure geometry for the schedule timeline: where a minute sits on the track,
 * which slot a minute falls in, and how the now line steps. No React, no DOM.
 * Minutes are minutes from midnight in the event timezone (D16).
 */

export type SlotTimes = { slot: number; startMinutes: number; endMinutes: number };

export type TimelineSpan = { start: number; end: number; length: number };

/** First slot start to last slot end. Slots are assumed sorted by start. */
export function timelineSpan(slots: readonly SlotTimes[]): TimelineSpan {
  if (slots.length === 0) return { start: 0, end: 0, length: 0 };
  const start = Math.min(...slots.map((s) => s.startMinutes));
  const end = Math.max(...slots.map((s) => s.endMinutes));
  return { start, end, length: end - start };
}

export function clampMinute(minute: number, span: TimelineSpan): number {
  return Math.max(span.start, Math.min(span.end, Math.round(minute)));
}

/** Position of a minute along the track, 0 to 100. */
export function minutesToPercent(minute: number, span: TimelineSpan): number {
  if (span.length <= 0) return 0;
  const pct = ((minute - span.start) / span.length) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Left and width, in percent of the track, for a block from `start` to `end`. */
export function rangeToPercent(start: number, end: number, span: TimelineSpan): { left: number; width: number } {
  const left = minutesToPercent(start, span);
  return { left, width: minutesToPercent(end, span) - left };
}

/** The minute under a pointer, given its fraction (0 to 1) across the track. */
export function minuteAtFraction(fraction: number, span: TimelineSpan): number {
  return clampMinute(span.start + fraction * span.length, span);
}

export type NowPhase =
  | { phase: "before"; next: SlotTimes }
  | { phase: "in"; slot: SlotTimes; minutesIn: number; minutesLeft: number }
  | { phase: "gap"; slot: SlotTimes; next: SlotTimes }
  | { phase: "after" };

/** What is happening at `minute`: before the first slot, inside one, in a changeover, or after the last. */
export function phaseAt(minute: number, slots: readonly SlotTimes[]): NowPhase {
  if (slots.length === 0) return { phase: "after" };
  const last = slots[slots.length - 1];
  if (minute >= last.endMinutes) return { phase: "after" };
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (minute >= s.startMinutes && minute < s.endMinutes) {
      return { phase: "in", slot: s, minutesIn: minute - s.startMinutes, minutesLeft: s.endMinutes - minute };
    }
    const next = slots[i + 1];
    if (next && minute >= s.endMinutes && minute < next.startMinutes) return { phase: "gap", slot: s, next };
  }
  return { phase: "before", next: slots[0] };
}

/** The slot number at `minute`, or null outside every slot (changeovers included). */
export function slotAtMinute(minute: number, slots: readonly SlotTimes[]): number | null {
  const p = phaseAt(minute, slots);
  return p.phase === "in" ? p.slot.slot : null;
}

/** The slot staff care about at `minute`: the live one, the next one in a changeover, else the first or last. */
export function focusSlotAt(minute: number, slots: readonly SlotTimes[]): number | null {
  if (slots.length === 0) return null;
  const p = phaseAt(minute, slots);
  switch (p.phase) {
    case "in":
      return p.slot.slot;
    case "gap":
    case "before":
      return p.next.slot;
    case "after":
      return slots[slots.length - 1].slot;
  }
}

/** Start of the first slot after `minute`, or the end of the afternoon. */
export function nextSlotStart(minute: number, slots: readonly SlotTimes[], span: TimelineSpan): number {
  return slots.find((s) => s.startMinutes > minute)?.startMinutes ?? span.end;
}

/** Start of the last slot before `minute`, or the start of the afternoon. */
export function prevSlotStart(minute: number, slots: readonly SlotTimes[], span: TimelineSpan): number {
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i].startMinutes < minute) return slots[i].startMinutes;
  }
  return span.start;
}

/** Gaps between consecutive slots (the 1-minute changeovers). */
export function changeovers(slots: readonly SlotTimes[]): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  for (let i = 0; i < slots.length - 1; i++) {
    const end = slots[i].endMinutes;
    const next = slots[i + 1].startMinutes;
    if (next > end) gaps.push({ start: end, end: next });
  }
  return gaps;
}

/** End minute of the last slot that has finished by `minute`, or null when none has. */
export function finishedThrough(minute: number, slots: readonly SlotTimes[]): number | null {
  let through: number | null = null;
  for (const s of slots) if (s.endMinutes <= minute) through = s.endMinutes;
  return through;
}

/**
 * Keyboard for the now handle: arrows step a minute, shift+arrow a slot,
 * Home and End jump to the ends. Returns null for keys it does not handle.
 */
export function stepNow(
  minute: number,
  key: string,
  shiftKey: boolean,
  slots: readonly SlotTimes[],
  span: TimelineSpan,
): number | null {
  const forward = key === "ArrowRight" || key === "ArrowUp";
  const back = key === "ArrowLeft" || key === "ArrowDown";
  if (forward) return shiftKey ? nextSlotStart(minute, slots, span) : clampMinute(minute + 1, span);
  if (back) return shiftKey ? prevSlotStart(minute, slots, span) : clampMinute(minute - 1, span);
  if (key === "Home") return span.start;
  if (key === "End") return span.end;
  if (key === "PageUp") return nextSlotStart(minute, slots, span);
  if (key === "PageDown") return prevSlotStart(minute, slots, span);
  return null;
}

/**
 * Where the now line starts: the live time in the event timezone on the show
 * day (clamped to the afternoon), otherwise the first slot start.
 */
export function initialNow(input: {
  eventDate: string;
  today: string;
  liveMinutes: number;
  span: TimelineSpan;
}): { minute: number; live: boolean } {
  if (input.eventDate === input.today) return { minute: clampMinute(input.liveMinutes, input.span), live: true };
  return { minute: input.span.start, live: false };
}

/**
 * Play afternoon: the next now value. Normal motion steps a minute; reduced
 * motion jumps to the next slot start. Returns null when the afternoon is over.
 */
export function playStep(
  minute: number,
  reducedMotion: boolean,
  slots: readonly SlotTimes[],
  span: TimelineSpan,
): number | null {
  if (minute >= span.end) return null;
  return reducedMotion ? nextSlotStart(minute, slots, span) : clampMinute(minute + 1, span);
}

/** "3:47" and "PM" for the clock readout. */
export function clockParts(minute: number): { time: string; meridiem: "AM" | "PM" } {
  const wrapped = ((Math.round(minute) % 1440) + 1440) % 1440;
  const h24 = Math.floor(wrapped / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { time: `${h12}:${String(wrapped % 60).padStart(2, "0")}`, meridiem: h24 < 12 ? "AM" : "PM" };
}

/** Today's date in the event timezone as "YYYY-MM-DD", to compare with `events.event_date`. */
export function dateInTimezone(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
