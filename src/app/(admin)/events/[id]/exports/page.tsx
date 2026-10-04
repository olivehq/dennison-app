import { formatDistanceToNow } from "date-fns";
import { DownloadIcon, TriangleAlertIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getEvent } from "@/server/events/queries";
import type { ExportKind } from "@/server/exports/kinds";
import { exportAvailability, type ExportState } from "@/server/exports/queries";
import { AccessListButton } from "./access-list-button";

const ROUTE_SEGMENT: Record<ExportKind, string> = {
  master: "master",
  schedules: "schedules",
  report: "report",
  access_list: "access",
};

function copyFor(kind: ExportKind, slotCount: number): { title: string; description: string; action: string } {
  switch (kind) {
    case "master":
      return {
        title: "Master schedule",
        description: "Every appointment with times, desk, and both ranks, sorted by slot then buyer.",
        action: "Download CSV",
      };
    case "schedules":
      return {
        title: "Individual schedules",
        description: `A ZIP with one CSV per buyer and supplier, all ${slotCount} slots with OPEN gaps, and no ranks.`,
        action: "Download ZIP",
      };
    case "report":
      return {
        title: "Quality report",
        description: "Sections A to G: appointment counts, top-10 matches, blank rankings, and key insights.",
        action: "Download report",
      };
    case "access_list":
      return {
        title: "Participant access list",
        description: "Each contact's name, email, and private schedule link, for sending by hand if email fails.",
        action: "Download access list",
      };
  }
}

function LastGenerated({ state }: { state: ExportState }) {
  if (!state.last) return <p className="text-sm text-muted-foreground">Not generated yet</p>;
  const when = formatDistanceToNow(state.last.at, { addSuffix: true });
  return (
    <p className="text-sm text-muted-foreground">
      Generated {when}
      {state.last.byName ? ` by ${state.last.byName}` : null}
    </p>
  );
}

export default async function ExportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const availability = await exportAvailability(event.id);
  if (!availability) notFound();

  const kinds: ExportKind[] = ["master", "schedules", "report", "access_list"];

  return (
    <>
      <PageHeader title="Exports" description="Files for D&A staff and participants, built from the active schedule." />
      <div className="grid gap-4 md:grid-cols-2">
        {kinds.map((kind) => {
          const state = availability.exports[kind];
          const copy = copyFor(kind, event.settings.slotCount);
          const href = `/api/exports/${event.id}/${ROUTE_SEGMENT[kind]}`;
          return (
            <Card key={kind} className="min-w-0">
              <CardHeader>
                <CardTitle className="font-display text-lg font-bold">{copy.title}</CardTitle>
                <CardDescription>{copy.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col items-start gap-2">
                <LastGenerated state={state} />
                {state.scheduleChanged ? (
                  <Badge variant="outline" className="border-warning bg-warning/15 text-warning-foreground">
                    <TriangleAlertIcon data-icon="inline-start" />
                    Schedule changed since this export
                  </Badge>
                ) : null}
                {state.reason ? <p className="text-sm text-muted-foreground">{state.reason}</p> : null}
              </CardContent>
              <CardFooter className="mt-auto">
                {kind === "access_list" ? (
                  <AccessListButton
                    href={href}
                    filename={state.filename}
                    label={copy.action}
                    disabled={!state.available}
                  />
                ) : state.available ? (
                  <Button variant="outline" asChild>
                    <a href={href} download={state.filename}>
                      <DownloadIcon data-icon="inline-start" />
                      {copy.action}
                    </a>
                  </Button>
                ) : (
                  <Button variant="outline" disabled>
                    <DownloadIcon data-icon="inline-start" />
                    {copy.action}
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </>
  );
}
