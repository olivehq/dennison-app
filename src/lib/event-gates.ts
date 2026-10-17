import type { EventStatus } from "@/db/schema";

/**
 * Which event statuses allow which writes (AGENTS.md invariants). Pure, so
 * client components can use it. Server writes claim the event row against a
 * gate with `inEventTransaction` in `src/server/events/editable.ts`.
 */
export const EVENT_GATES = {
  /** Roster, imports, matching, schedule edits, settings, and lock itself. */
  edit: ["draft", "imported", "matched"],
  /** Email sends and unlock. */
  locked: ["locked", "sent"],
  /** Campaign drafts, test sends, participant links, the retention switch, and archive. */
  unarchived: ["draft", "imported", "matched", "locked", "sent"],
  /** Deleting the event. */
  draft: ["draft"],
} as const satisfies Record<string, readonly EventStatus[]>;

export type EventGate = keyof typeof EVENT_GATES;

export function eventAllows(gate: EventGate, status: EventStatus): boolean {
  return (EVENT_GATES[gate] as readonly EventStatus[]).includes(status);
}
