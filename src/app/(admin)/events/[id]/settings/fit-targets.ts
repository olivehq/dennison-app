import type { EventSettings } from "@/lib/schemas/event-settings";

/** The meeting targets that must fit the slot count (the refinements in `eventSettingsSchema`). */
export type MeetingTargets = Pick<EventSettings, "supplierTarget" | "buyerMin" | "buyerIdeal" | "buyerMax">;

export type TargetChange = { field: keyof MeetingTargets; from: number; to: number };

const LABEL: Record<keyof MeetingTargets, string> = {
  supplierTarget: "meetings per supplier",
  buyerMin: "buyer minimum",
  buyerIdeal: "buyer ideal",
  buyerMax: "buyer maximum",
};

/**
 * Moves the meeting targets into range after "Rebuild slots": none above
 * `slotCount`, minimum at most maximum, ideal between them. A blank field
 * (NaN) is left for the form's own validation. Pure, so it is unit tested.
 */
export function fitTargetsToSlots(
  targets: MeetingTargets,
  slotCount: number,
): { targets: MeetingTargets; changes: TargetChange[] } {
  const known = (value: number, otherwise: number) => (Number.isFinite(value) ? value : otherwise);
  const fit = (value: number, low: number, high: number) =>
    Number.isFinite(value) ? Math.min(Math.max(value, low), high) : value;
  const supplierTarget = fit(targets.supplierTarget, -Infinity, slotCount);
  const buyerMax = fit(targets.buyerMax, -Infinity, slotCount);
  const buyerMin = fit(targets.buyerMin, -Infinity, known(buyerMax, slotCount));
  const buyerIdeal = fit(targets.buyerIdeal, known(buyerMin, -Infinity), known(buyerMax, slotCount));
  const next: MeetingTargets = { supplierTarget, buyerMin, buyerIdeal, buyerMax };
  const changes = (Object.keys(LABEL) as (keyof MeetingTargets)[])
    .filter((field) => Number.isFinite(targets[field]) && next[field] !== targets[field])
    .map((field) => ({ field, from: targets[field], to: next[field] }));
  return { targets: next, changes };
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Lowered meetings per supplier to 8 and buyer maximum to 8 to fit." Null when nothing changed. */
export function describeTargetChanges(changes: TargetChange[]): string | null {
  if (changes.length === 0) return null;
  const phrase = (c: TargetChange) => `${LABEL[c.field]} to ${c.to}`;
  const lowered = changes.filter((c) => c.to < c.from).map(phrase);
  const raised = changes.filter((c) => c.to > c.from).map(phrase);
  const parts = [lowered.length ? `Lowered ${joinAnd(lowered)}` : null, raised.length ? `raised ${joinAnd(raised)}` : null]
    .filter((part): part is string => part !== null)
    .join(" and ");
  return `${parts.charAt(0).toUpperCase()}${parts.slice(1)} to fit.`;
}

const sameTargets = (a: MeetingTargets, b: MeetingTargets) =>
  (Object.keys(LABEL) as (keyof MeetingTargets)[]).every((field) => a[field] === b[field]);

/** "Targets stay at 7." or "Targets stay at 9 per supplier and 7 to 9 per buyer (ideal 8)." */
function describeKeptTargets(t: MeetingTargets): string {
  if (new Set(Object.values(t)).size === 1) return `Targets stay at ${t.supplierTarget}.`;
  return `Targets stay at ${t.supplierTarget} per supplier and ${t.buyerMin} to ${t.buyerMax} per buyer (ideal ${t.buyerIdeal}).`;
}

/**
 * What to tell the admin after "Rebuild slots" adds slots. Raising the slot count never raises the
 * targets, so when they sit below the new count the note says they stayed, and the restore option puts
 * back the values they had before the last lowering (`previous`) or else the defaults, fitted to the
 * new count. Null when the count did not grow or the targets already reach it.
 */
export function describeRebuildUp(
  current: MeetingTargets,
  slotCount: number,
  previousSlotCount: number,
  previous: MeetingTargets | null,
  defaults: MeetingTargets,
): { note: string; restore: { label: string; targets: MeetingTargets } | null } | null {
  if (slotCount <= previousSlotCount) return null;
  if (!Object.values(current).every(Number.isFinite)) return null;
  if (current.supplierTarget >= slotCount && current.buyerMax >= slotCount) return null;
  const from = previous ?? defaults;
  const candidate = fitTargetsToSlots(from, slotCount).targets;
  return {
    note: `${describeKeptTargets(current)} Raise them if you want more meetings.`,
    restore: sameTargets(candidate, current)
      ? null
      : { label: previous ? "Restore previous targets" : "Use default targets", targets: candidate },
  };
}
