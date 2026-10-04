import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { EventStatus } from "@/lib/schemas/event";
import { getEvent, getEventCounts } from "@/server/events/queries";
import { EVENT_STATUS_LABELS } from "../event-status-badge";
import { DeleteEventButton } from "./delete-event-button";
import { eventSectionHref } from "./event-sections";

const STEPS: EventStatus[] = ["draft", "imported", "matched", "locked", "sent"];

const NEXT_ACTION: Record<EventStatus, { title: string; description: string; segment: string; label: string }> = {
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
    label: "Open the schedule",
  },
  archived: {
    title: "Download the records",
    description: "This event is finished. Exports stay available until the retention date.",
    segment: "exports",
    label: "Go to exports",
  },
};

function StatusStepper({ status }: { status: EventStatus }) {
  const current = status === "archived" ? STEPS.length : STEPS.indexOf(status);
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Event progress">
      {STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "inline-flex h-7 items-center gap-2 rounded-md border px-2.5 text-sm font-medium",
                active && "border-foreground bg-foreground text-background",
                done && "border-transparent bg-secondary text-secondary-foreground",
                !active && !done && "border-dashed text-muted-foreground",
              )}
            >
              <span className="font-display tabular-nums">{index + 1}</span>
              {EVENT_STATUS_LABELS[step]}
            </span>
            {index < STEPS.length - 1 ? (
              <span className="h-px w-3 bg-border" aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function CountCard({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="font-display text-3xl font-bold tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <Button variant="link" size="sm" className="h-auto p-0" asChild>
          <Link href={href}>View</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default async function EventOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const counts = await getEventCounts(event.id);
  const next = NEXT_ACTION[event.status];
  const canDelete = event.status === "draft" && counts.participants === 0;

  return (
    <>
      <StatusStepper status={event.status} />
      <div className="grid gap-4 sm:grid-cols-3">
        <CountCard label="Participants" value={counts.participants} href={eventSectionHref(event.id, "participants")} />
        <CountCard label="Suppliers" value={counts.suppliers} href={eventSectionHref(event.id, "suppliers")} />
        <CountCard label="Appointments" value={counts.appointments} href={eventSectionHref(event.id, "schedule")} />
      </div>
      <Card className="max-w-xl">
        <CardHeader>
          <CardDescription>Next</CardDescription>
          <CardTitle className="font-display text-xl font-bold">{next.title}</CardTitle>
          <CardDescription>{next.description}</CardDescription>
        </CardHeader>
        <CardFooter className="gap-2">
          <Button asChild>
            <Link href={eventSectionHref(event.id, next.segment)}>
              {next.label}
              <ArrowRightIcon data-icon="inline-end" />
            </Link>
          </Button>
          {counts.activeRunId ? null : event.status === "draft" ? (
            <Button variant="outline" asChild>
              <Link href={eventSectionHref(event.id, "settings")}>Check settings</Link>
            </Button>
          ) : null}
        </CardFooter>
      </Card>
      {canDelete ? <DeleteEventButton eventId={event.id} eventName={event.name} /> : null}
    </>
  );
}
