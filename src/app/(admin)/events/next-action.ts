import type { EventStatus } from "@/lib/schemas/event";

export type NextAction = { title: string; description: string; segment: string; label: string };

/** What to do next for each status, shown on the event overview and the events list. */
export const NEXT_ACTION: Record<EventStatus, NextAction> = {
  draft: {
    title: "Import the files",
    description: "Upload participants, suppliers, and the three ranking files from eShow.",
    segment: "imports",
    label: "Go to imports",
  },
  imported: {
    title: "Run matching",
    description: "The engine builds a schedule from the rankings. You can re-run it as often as you like.",
    segment: "matching",
    label: "Go to matching",
  },
  matched: {
    title: "Review and lock the schedule",
    description: "Check counts, fix problems by hand, then lock it so desks and times stop changing.",
    segment: "schedule",
    label: "Go to schedule",
  },
  locked: {
    title: "Send schedules",
    description: "Email every buyer and supplier their private schedule link.",
    segment: "emails",
    label: "Go to emails",
  },
  sent: {
    title: "Run the show",
    description: "Follow the live timeline. Changes after sending go out as update emails.",
    segment: "schedule",
    label: "Go to schedule",
  },
  archived: {
    title: "Download the records",
    description: "This event is finished. Exports stay available until the retention date.",
    segment: "exports",
    label: "Go to exports",
  },
};
