import { notFound } from "next/navigation";
import { formatEventDate } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import { EventHeader } from "./event-header";

export default async function EventLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();

  return (
    <div className="flex flex-1 flex-col gap-2">
      <EventHeader
        event={{ id: event.id, name: event.name, status: event.status }}
        when={`${formatEventDate(event.eventDate, event.timezone)}, ${event.timezone.replace(/_/g, " ")}`}
      />
      <div className="flex flex-1 flex-col gap-6">{children}</div>
    </div>
  );
}
