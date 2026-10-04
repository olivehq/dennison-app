import { notFound } from "next/navigation";
import { isEventEditable } from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { EventSettingsForm } from "./event-settings-form";

export default async function EventSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();

  const readOnlyReason = isEventEditable(event)
    ? null
    : event.status === "archived"
      ? "This event is archived. Its settings can't be changed."
      : "Settings are read-only while the schedule is locked. Unlock it on the Schedule page to make changes.";

  return (
    <EventSettingsForm
      key={event.updatedAt.toISOString()}
      event={{
        id: event.id,
        name: event.name,
        eventDate: event.eventDate,
        timezone: event.timezone,
        settings: event.settings,
      }}
      readOnlyReason={readOnlyReason}
    />
  );
}
