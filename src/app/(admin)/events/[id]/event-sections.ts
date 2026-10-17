import {
  Building2Icon,
  CalendarClockIcon,
  DownloadIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  MailIcon,
  SettingsIcon,
  ShuffleIcon,
  UploadIcon,
  UsersIcon,
} from "lucide-react";

/** One event's sections, grouped as the sidebar shows them. Plain module so server and client code can build hrefs. */
export const EVENT_SECTION_GROUPS = [
  { label: null, sections: [{ segment: "", label: "Overview", icon: LayoutDashboardIcon }] },
  {
    label: "Prepare",
    sections: [
      { segment: "participants", label: "Participants", icon: UsersIcon },
      { segment: "suppliers", label: "Suppliers", icon: Building2Icon },
      { segment: "imports", label: "Imports", icon: UploadIcon },
    ],
  },
  {
    label: "Schedule",
    sections: [
      { segment: "matching", label: "Matching", icon: ShuffleIcon },
      { segment: "schedule", label: "Schedule", icon: CalendarClockIcon },
    ],
  },
  {
    label: "Deliver",
    sections: [
      { segment: "exports", label: "Exports", icon: DownloadIcon },
      { segment: "emails", label: "Emails", icon: MailIcon },
    ],
  },
  {
    label: "Event",
    sections: [
      { segment: "activity", label: "Activity", icon: HistoryIcon },
      { segment: "settings", label: "Settings", icon: SettingsIcon },
    ],
  },
] as const;

type SectionDef = (typeof EVENT_SECTION_GROUPS)[number]["sections"][number];

export const EVENT_SECTIONS: readonly SectionDef[] = EVENT_SECTION_GROUPS.flatMap((group): readonly SectionDef[] => group.sections);

export type EventSection = SectionDef["segment"];

/**
 * Holds the id of the last event the admin opened, so pages outside an event
 * can keep it in the sidebar. The sidebar sets it in the browser; the server
 * only shows the event when the id names one that exists.
 */
export const LAST_EVENT_COOKIE = "aw-last-event";

export function eventSectionHref(eventId: string, segment: EventSection | string): string {
  return segment ? `/events/${eventId}/${segment}` : `/events/${eventId}`;
}

export type SectionMatch = {
  segment: EventSection;
  label: string;
  /** The path is below the section's own page, such as one import or one email. */
  nested: boolean;
};

/** The section of this event the path is in, or null when the path is outside the event or names no section. */
export function sectionForPath(pathname: string, eventId: string): SectionMatch | null {
  const base = eventSectionHref(eventId, "");
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  const [segment = "", ...rest] = pathname.slice(base.length + 1).split("/").filter(Boolean);
  const section = EVENT_SECTIONS.find((s) => s.segment === segment);
  return section ? { segment: section.segment, label: section.label, nested: rest.length > 0 } : null;
}
