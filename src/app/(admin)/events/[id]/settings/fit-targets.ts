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
