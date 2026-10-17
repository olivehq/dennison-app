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
import { listSuppliers } from "@/server/roster/queries";
import { readContactLinks } from "@/server/tokens/queries";
import { linkOf } from "../_roster/link-status";
import { ExportFullListButton } from "../_roster/export-full-list-button";
import { linksBlockedReason, lockReason } from "../_roster/lock-reason";
import { emailChangeOf } from "../_roster/email-change";
import { combineEmailChange, healthFor, parseLinkFilter, parseSearchQuery, parseStatusFilter, parseTypeFilter } from "../_roster/types";
import { eventSectionHref } from "../event-sections";
import { AddSupplierButton, SuppliersTable, type SupplierTableRow } from "./suppliers-table";

export default async function SuppliersPage({
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

  const [suppliers, links, activeRun, emailState] = await Promise.all([
    listSuppliers(event.id, { includeWithdrawn: true }),
    readContactLinks(db, event.id, { withUrls: false }),
    findActiveRun(db, event.id),
    getScheduleChangeState(event.id),
  ]);
  const hasRun = activeRun !== null;
  const target = event.settings.supplierTarget;
  const locked = lockReason(event, "add, edit, or withdraw suppliers");
  const linksBlocked = linksBlockedReason(event);

  const rows: SupplierTableRow[] = suppliers.map((s) => {
    const health = healthFor(s.appointmentCount, target, target, hasRun, s.status === "withdrawn");
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      deskNumber: s.deskNumber,
      deskOverride: s.deskOverride,
      adminContactName: s.adminContactName,
      adminContactEmail: s.adminContactEmail,
      attendeeContactName: s.attendeeContactName,
      attendeeContactEmail: s.attendeeContactEmail,
      status: s.status,
      appointmentCount: s.appointmentCount,
      health,
      healthHint:
        health === "low" ? `below the target of ${target}` : health === "high" ? `above the target of ${target}` : undefined,
      adminLink: linkOf(links, "supplier_admin", s.id),
      attendeeLink: linkOf(links, "supplier_attendee", s.id),
      emailChange: combineEmailChange(
        emailChangeOf(emailState, recipientKey("supplier_admin", s.id)),
        emailChangeOf(emailState, recipientKey("supplier_attendee", s.id)),
      ),
    };
  });
  const active = rows.filter((row) => row.status === "active").length;
  const withdrawn = rows.length - active;
  const hotels = rows.filter((row) => row.status === "active" && row.type === "hotel").length;

  return (
    <>
      <PageHeader
        title="Suppliers"
        description={`${active} active (${hotels} hotel, ${active - hotels} business)${withdrawn ? `, ${withdrawn} withdrawn` : ""}.`}
        actions={
          <>
            <ExportFullListButton eventId={event.id} eventDate={event.eventDate} kind="suppliers_full" />
            <AddSupplierButton eventId={event.id} disabled={locked !== null} />
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
      <SuppliersTable
        eventId={event.id}
        rows={rows}
        lockedReason={locked}
        linksBlockedReason={linksBlocked}
        importsHref={eventSectionHref(event.id, "imports")}
        initialStatus={parseStatusFilter(query.status)}
        initialType={parseTypeFilter(query.type)}
        initialLink={parseLinkFilter(query.link)}
        initialQuery={parseSearchQuery(query.q)}
      />
    </>
  );
}
