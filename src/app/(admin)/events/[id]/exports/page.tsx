import { formatDistanceToNow } from "date-fns";
import { DownloadIcon, TriangleAlertIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import type { ExportKind } from "@/server/exports/kinds";
import { exportAvailability, type ExportState } from "@/server/exports/queries";
import { getActiveRun } from "@/server/matching/queries";
import { AccessListButton } from "./access-list-button";
import { DownloadButton } from "./download-button";

/** The report route refuses a run saved without statistics; matching again rebuilds them. */
const NO_STATS_REASON = "The active run has no statistics. Run matching again to rebuild them.";

const ROUTE_SEGMENT: Record<ExportKind, string> = {
  master: "master",
  schedules: "schedules",
  report: "report",
  access_list: "access",
  participants_full: "participants",
  suppliers_full: "suppliers",
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
        description: `A ZIP with one CSV per buyer and supplier, all ${slotCount} slots with OPEN gaps, no ranks, and the person's schedule link under the slots.`,
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
    case "participants_full":
      return {
        title: "Participants (full list)",
        description:
          "Every participant, withdrawn people included, with contact details, biztech opt-in, appointment count, and link status.",
        action: "Download CSV",
      };
    case "suppliers_full":
      return {
        title: "Suppliers (full list)",
        description:
          "Every supplier, withdrawn ones included, with desk, both contacts, appointment count, and link status for each contact.",
        action: "Download CSV",
      };
  }
}

/** What downloading the access list does to links (D31, D59, D43). Shown beside the button instead of a confirm. */
function accessListNote(archived: boolean): string {
  if (archived) {
    return "This event is archived, so downloading issues no links. The file shows each person's current link, or why they don't have one.";
  }
  return "Downloading reuses each person's current link, so links you've already sent keep working. People who never had a link, or whose link expired or can't be read back, get a new one. Revoked links stay revoked; use Regenerate on the roster to give someone a new link.";
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
  await requireSession();
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const availability = await exportAvailability(event.id);
  if (!availability) notFound();
  const activeRun = availability.activeRun ? await getActiveRun(event.id) : null;
  const reportReason = availability.activeRun && !activeRun?.stats ? NO_STATS_REASON : null;

  const kinds: ExportKind[] = ["master", "schedules", "report", "access_list", "participants_full", "suppliers_full"];

  return (
    <>
      <PageHeader title="Exports" description="Files for D&A staff and participants. Schedule files come from the active schedule." />
      <div className="grid gap-4 md:grid-cols-2">
        {kinds.map((kind) => {
          const state = availability.exports[kind];
          const disabledReason = state.reason ?? (kind === "report" ? reportReason : null);
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
                {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}
                {kind === "access_list" && state.available ? (
                  <p className="text-sm text-muted-foreground">{accessListNote(event.status === "archived")}</p>
                ) : null}
              </CardContent>
              <CardFooter className="mt-auto">
                {kind === "access_list" ? (
                  <AccessListButton
                    href={href}
                    filename={state.filename}
                    label={copy.action}
                    disabled={!state.available}
                  />
                ) : disabledReason ? (
                  <Button variant="outline" disabled>
                    <DownloadIcon data-icon="inline-start" />
                    {copy.action}
                  </Button>
                ) : (
                  <DownloadButton href={href} filename={state.filename} label={copy.action} />
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </>
  );
}
