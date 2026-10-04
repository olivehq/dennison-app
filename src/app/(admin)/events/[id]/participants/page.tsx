import { LockIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { recipientKey } from "@/lib/schemas/email";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { requireSession } from "@/server/auth/session";
import { getScheduleChangeState } from "@/server/email/queries";
import { getEvent, getEventCounts } from "@/server/events/queries";
import { fullNameFor, listParticipants } from "@/server/roster/queries";
import { listTokens } from "@/server/tokens/queries";
import { latestLinks, linkOf } from "../_roster/link-status";
import { lockReason } from "../_roster/lock-reason";
import { emailChangeOf } from "../_roster/email-change";
import { healthFor, parseBiztechFilter, parseStatusFilter } from "../_roster/types";
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
  const event = await getEvent(id);
  if (!event) notFound();

  const [participants, tokens, counts, emailState] = await Promise.all([
    listParticipants(event.id, { includeWithdrawn: true }),
    listTokens(event.id),
    getEventCounts(event.id),
    getScheduleChangeState(event.id),
  ]);
  const links = latestLinks(tokens);
  const hasRun = counts.activeRunId !== null;
  const { buyerMin, buyerMax } = event.settings;
  const locked = lockReason(event, "add, edit, or withdraw participants");

  const rows: ParticipantTableRow[] = participants.map((p) => {
    const health = healthFor(p.appointmentCount, buyerMin, buyerMax, hasRun);
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
        actions={<AddParticipantButton eventId={event.id} disabled={locked !== null} />}
      />
      {locked ? (
        <Alert>
          <LockIcon />
          <AlertTitle>Read-only</AlertTitle>
          <AlertDescription>{locked} You can still regenerate and revoke links.</AlertDescription>
        </Alert>
      ) : null}
      <ParticipantsTable
        eventId={event.id}
        rows={rows}
        lockedReason={locked}
        importsHref={eventSectionHref(event.id, "imports")}
        initialStatus={parseStatusFilter(query.status)}
        initialBiztech={parseBiztechFilter(query.biztech)}
      />
    </>
  );
}
