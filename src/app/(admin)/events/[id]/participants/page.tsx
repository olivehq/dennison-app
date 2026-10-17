import { LockIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { recipientKey } from "@/lib/schemas/email";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getDb } from "@/db/client";
import { requireSession } from "@/server/auth/session";
import { getScheduleChangeState } from "@/server/email/queries";
import { getEvent } from "@/server/events/queries";
import { findActiveRun } from "@/server/matching/runs";
import { fullNameFor, listParticipants } from "@/server/roster/queries";
import { readContactLinks } from "@/server/tokens/queries";
import { linkOf } from "../_roster/link-status";
import { ExportFullListButton } from "../_roster/export-full-list-button";
import { linksBlockedReason, lockReason } from "../_roster/lock-reason";
import { emailChangeOf } from "../_roster/email-change";
import { healthFor, parseBiztechFilter, parseLinkFilter, parseSearchQuery, parseStatusFilter } from "../_roster/types";
import { eventSectionHref } from "../event-sections";
import { AddParticipantButton, ParticipantsTable, type ParticipantTableRow } from "./participants-table";

/** Full name, organization, and title, skipping anything the display label already shows. */
function secondaryLine(label: string, parts: (string | null)[]): string {
  return parts.filter((part): part is string => !!part && !label.includes(part)).join(" · ");
}

export default async function ParticipantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const db = getDb();
  const event = await getEvent(id);
  if (!event) notFound();

  const [participants, links, activeRun, emailState] = await Promise.all([
    listParticipants(event.id, { includeWithdrawn: true }),
    readContactLinks(db, event.id, { withUrls: false }),
    findActiveRun(db, event.id),
    getScheduleChangeState(event.id),
  ]);
  const hasRun = activeRun !== null;
  const { buyerMin, buyerMax } = event.settings;
  const locked = lockReason(event, "add, edit, or withdraw participants");
  const linksBlocked = linksBlockedReason(event);

  const rows: ParticipantTableRow[] = participants.map((p) => {
    const health = healthFor(p.appointmentCount, buyerMin, buyerMax, hasRun, p.status === "withdrawn");
    return {
      id: p.id,
      email: p.email,
      firstName: p.firstName,
      lastName: p.lastName,
      organization: p.organization,
      title: p.title,
      displayName: p.displayName,
      biztechOptIn: p.biztechOptIn,
      displayLabel: p.displayLabel,
      secondary: secondaryLine(p.displayLabel, [fullNameFor(p), p.organization, p.title]),
      status: p.status,
      appointmentCount: p.appointmentCount,
      health,
      healthHint:
        health === "low" ? `below the minimum of ${buyerMin}` : health === "high" ? `above the maximum of ${buyerMax}` : undefined,
      link: linkOf(links, "buyer", p.id),
      emailChange: emailChangeOf(emailState, recipientKey("buyer", p.id)),
    };
  });
  const active = rows.filter((row) => row.status === "active").length;
  const withdrawn = rows.length - active;

  return (
    <>
      <PageHeader
        title="Participants"
        description={`${active} active${withdrawn ? `, ${withdrawn} withdrawn` : ""}. Buyers who rank suppliers and get a schedule.`}
        actions={
          <>
            <ExportFullListButton eventId={event.id} eventDate={event.eventDate} kind="participants_full" />
            <AddParticipantButton eventId={event.id} disabled={locked !== null} />
          </>
        }
      />
      {locked ? (
        <Alert>
          <LockIcon />
          <AlertTitle>Read-only</AlertTitle>
          <AlertDescription>
            {linksBlocked ? `${locked} Its links can't be regenerated or revoked.` : `${locked} You can still regenerate and revoke links.`}
          </AlertDescription>
        </Alert>
      ) : null}
      <ParticipantsTable
        eventId={event.id}
        rows={rows}
        lockedReason={locked}
        linksBlockedReason={linksBlocked}
        importsHref={eventSectionHref(event.id, "imports")}
        initialStatus={parseStatusFilter(query.status)}
        initialBiztech={parseBiztechFilter(query.biztech)}
        initialLink={parseLinkFilter(query.link)}
        initialQuery={parseSearchQuery(query.q)}
      />
    </>
  );
}
