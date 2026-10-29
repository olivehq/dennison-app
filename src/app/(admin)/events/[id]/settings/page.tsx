import { notFound } from "next/navigation";
import { formatEventDate } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { logoUrl } from "@/server/events/branding";
import { isEventEditable } from "@/server/events/editable";
import { getEvent, wasParticipantDataDeleted } from "@/server/events/queries";
import { retentionDeadline, retentionDeleteDate } from "@/server/events/retention";
import { BrandingCard } from "./branding-card";
import { EventSettingsForm } from "./event-settings-form";
import { RetentionCard } from "./retention-card";

export default async function EventSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const archived = event.status === "archived";
  const purged = archived && (await wasParticipantDataDeleted(event.id));

  const readOnlyReason = isEventEditable(event)
    ? null
    : event.status === "archived"
      ? "This event is archived. Its settings can't be changed."
      : "Settings are read-only while the schedule is locked. Unlock it on the Schedule page to make changes.";

  return (
    <>
      <EventSettingsForm
        // Each card remounts only when its own saved values change, so saving one keeps the other's unsaved
        // edits. retainData belongs to the retention card.
        key={JSON.stringify([event.name, event.eventDate, event.timezone, { ...event.settings, retainData: undefined }])}
        event={{
          id: event.id,
          name: event.name,
          eventDate: event.eventDate,
          timezone: event.timezone,
          settings: event.settings,
        }}
        readOnlyReason={readOnlyReason}
      />
      <BrandingCard
        key={JSON.stringify(event.branding)}
        eventId={event.id}
        eventName={event.name}
        dateLabel={formatEventDate(event.eventDate, event.timezone)}
        colors={{ primaryColor: event.branding?.primaryColor ?? "", accentColor: event.branding?.accentColor ?? "" }}
        logoSrc={logoUrl(event.id, event.branding)}
        archived={archived}
      />
      <RetentionCard
        eventId={event.id}
        retainData={event.settings.retainData ?? false}
        deleteOn={formatEventDate(retentionDeleteDate(event.eventDate), event.timezone)}
        archived={archived}
        purged={purged}
        overdue={retentionDeadline(event) <= new Date()}
      />
    </>
  );
}
