import { cache } from "react";
import { formatEventDate } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { getEventNavCounts } from "@/server/events/nav-counts";
import { listEventSummaries, type EventSummary } from "@/server/events/queries";
import { AppSidebar, SidebarErrorBoundary, type SidebarEventSummary } from "../app-sidebar";
import { orderEvents } from "../events/event-order";

/** One read per request, however often the sidebar renders. */
const loadNavCounts = cache((eventId: string) => getEventNavCounts(eventId));

const RECENT_LIMIT = 5;

function summary(event: EventSummary): SidebarEventSummary {
  return {
    id: event.id,
    name: event.name,
    dateLabel: formatEventDate(event.eventDate, event.timezone, "short"),
    status: event.status,
  };
}

/**
 * The sidebar for one event: switcher, grouped sections, live counts. The id
 * comes from the URL or the last-event cookie, so it is only trusted once it
 * matches an event. With no match the sidebar lists recent events instead.
 * The counts start beside the event list and stream in after the links. A
 * failed read shows the links without counts instead of an error.
 */
export function EventSidebar({ eventId }: { eventId: string | undefined }) {
  return (
    <SidebarErrorBoundary>
      <LoadedSidebar eventId={eventId} />
    </SidebarErrorBoundary>
  );
}

async function LoadedSidebar({ eventId }: { eventId: string | undefined }) {
  await requireSession();
  // Null for an id that isn't a uuid or names no event.
  const counts = eventId ? loadNavCounts(eventId) : null;
  // Marks a failure handled while the list loads. A failure still reaches the
  // sidebar's error boundary through the promise the links read.
  counts?.catch(() => {});
  const events = await listEventSummaries();
  const event = eventId ? events.find((e) => e.id === eventId) : undefined;

  if (!event || !counts) {
    return <AppSidebar recent={orderEvents(events).slice(0, RECENT_LIMIT).map(summary)} />;
  }
  return (
    <AppSidebar event={{ current: summary(event), others: events.filter((e) => e.id !== event.id).map(summary), counts }} />
  );
}
