import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatEventDate } from "@/lib/time";
import { listEvents } from "@/server/events/queries";
import { CreateEventDialog } from "./create-event-dialog";
import { EventStatusBadge } from "./event-status-badge";

export default async function EventsPage() {
  const events = await listEvents();

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
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Event</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Participants</TableHead>
                <TableHead className="text-right">Suppliers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-medium">
                    <Link href={`/events/${event.id}`} className="hover:underline">
                      {event.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatEventDate(event.eventDate, event.timezone)}</TableCell>
                  <TableCell>
                    <EventStatusBadge status={event.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{event.participantCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{event.supplierCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
