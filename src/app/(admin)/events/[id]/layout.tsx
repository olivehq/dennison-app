import { notFound } from "next/navigation";
import { formatEventDate } from "@/lib/time";
import { getEvent } from "@/server/events/queries";
import { EventStatusBadge } from "../event-status-badge";
import { EventNav } from "./event-nav";

export default async function EventLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();

  return (
    <>
      <header className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="font-display text-[22px] leading-tight font-bold tracking-[-0.01em] text-balance sm:text-[26px]">
              {event.name}
            </h1>
            <EventStatusBadge status={event.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {formatEventDate(event.eventDate, event.timezone)}, {event.timezone.replace(/_/g, " ")}
          </p>
        </div>
        <EventNav eventId={event.id} />
      </header>
      <div className="flex flex-1 flex-col gap-6">{children}</div>
    </>
  );
}
