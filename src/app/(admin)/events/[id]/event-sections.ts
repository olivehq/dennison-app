/** The secondary nav for one event. Plain module so both server and client code can build hrefs. */
export const EVENT_SECTIONS = [
  { segment: "", label: "Overview" },
  { segment: "settings", label: "Settings" },
  { segment: "participants", label: "Participants" },
  { segment: "suppliers", label: "Suppliers" },
  { segment: "imports", label: "Imports" },
  { segment: "matching", label: "Matching" },
  { segment: "schedule", label: "Schedule" },
  { segment: "exports", label: "Exports" },
  { segment: "emails", label: "Emails" },
  { segment: "activity", label: "Activity" },
] as const;

export type EventSection = (typeof EVENT_SECTIONS)[number]["segment"];

export function eventSectionHref(eventId: string, segment: EventSection | string): string {
  return segment ? `/events/${eventId}/${segment}` : `/events/${eventId}`;
}
