import { CalendarClockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { nowInTimezone } from "@/lib/time";
import { getScheduleView } from "@/server/schedule/queries";
import { eventSectionHref } from "../event-sections";
import { ScheduleWorkspace } from "./schedule-workspace";
import { dateInTimezone } from "./timeline-geometry";

export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getScheduleView(id);
  if (!view) notFound();
  const { event, run } = view;

  if (!run) {
    return (
      <>
        <PageHeader title="Schedule" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClockIcon />
            </EmptyMedia>
            <EmptyTitle>No schedule yet</EmptyTitle>
            <EmptyDescription>
              Run matching to build a schedule from the rankings. The first run becomes the schedule you see here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link href={eventSectionHref(event.id, "matching")}>Go to matching</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </>
    );
  }

  const { supplierTarget, buyerMin, buyerMax, buyerIdeal, mutualTopN } = event.settings;
  // The show clock starts at the live time on the show day. Read once per request; the client keeps it ticking.
  const now = new Date();
  const serverNow = { today: dateInTimezone(event.timezone, now), minutes: nowInTimezone(event.timezone, now) };
  return (
    <ScheduleWorkspace
      data={{
        eventId: event.id,
        status: event.status,
        eventDate: event.eventDate,
        timezone: event.timezone,
        settings: { supplierTarget, buyerMin, buyerMax, buyerIdeal, mutualTopN },
        run: { id: run.id, version: run.version, stats: run.stats, warnings: run.warnings },
        slots: view.slots,
        suppliers: view.suppliers,
        buyers: view.buyers,
        appointments: view.appointments,
      }}
      serverNow={serverNow}
    />
  );
}
