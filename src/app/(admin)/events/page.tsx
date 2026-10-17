import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { formatEventDate } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { listEvents, type EventListItem } from "@/server/events/queries";
import { eventSectionHref } from "./[id]/event-sections";
import { CreateEventDialog } from "./create-event-dialog";
import { orderEvents } from "./event-order";
import { EventStatusBadge } from "./event-status-badge";
import { NEXT_ACTION } from "./next-action";

function EventCard({ event }: { event: EventListItem }) {
  const next = NEXT_ACTION[event.status];
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="font-display text-lg leading-tight font-bold">
          <h2>
            <Link href={eventSectionHref(event.id, "")} className="hover:underline">
              {event.name}
            </Link>
          </h2>
        </CardTitle>
        <CardDescription>{formatEventDate(event.eventDate, event.timezone)}</CardDescription>
        <CardAction>
          <EventStatusBadge status={event.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex-1">
        <dl className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Participants</dt>
            <dd className="font-display text-2xl font-bold tabular-nums">{event.participantCount}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Suppliers</dt>
            <dd className="font-display text-2xl font-bold tabular-nums">{event.supplierCount}</dd>
          </div>
        </dl>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-x-4 gap-y-2">
        <p className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">Next</span>
          <span className="font-medium">{next.title}</span>
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link href={eventSectionHref(event.id, next.segment)}>
            {next.label}
            <span className="sr-only"> for {event.name}</span>
            <ArrowRightIcon data-icon="inline-end" />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

export default async function EventsPage() {
  await requireSession();
  const events = orderEvents(await listEvents());

  return (
    <>
      <PageHeader
        title="Events"
        description="One event per show. Open one to import files, run matching, and manage the schedule."
        actions={<CreateEventDialog />}
      />
      {events.length === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyTitle>No events yet</EmptyTitle>
            <EmptyDescription>Create the first event to start importing participants and rankings.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <CreateEventDialog />
          </EmptyContent>
        </Empty>
      ) : (
        <div className="@container">
          <ul className="grid gap-4 @xl:grid-cols-2 @5xl:grid-cols-3" aria-label="Events">
            {events.map((event) => (
              <li key={event.id} className="min-w-0">
                <EventCard event={event} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
