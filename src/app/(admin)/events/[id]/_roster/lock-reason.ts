import { isEventEditable } from "@/server/events/editable";

type EventLike = Parameters<typeof isEventEditable>[0];

/** Why changes are blocked, worded for the page, or null when the event is editable (D27). */
export function lockReason(event: EventLike, changes: string): string | null {
  if (isEventEditable(event)) return null;
  if (event.status === "archived") return `This event is archived, so you can't ${changes}.`;
  return `The schedule is locked. Unlock it on the Schedule page to ${changes}.`;
}
