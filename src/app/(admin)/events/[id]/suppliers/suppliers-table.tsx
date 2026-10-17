"use client";

import * as React from "react";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { ACTIONS_COLUMN_CLASS, createDataTableColumnHelper, DataTable, NAME_COLUMN } from "@/components/app/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { restoreSupplierAction, withdrawSupplierAction } from "@/server/roster/actions";
import {
  AppointmentCount,
  EmailChangeBadge,
  LinkBadge,
  LinkFilterSelect,
  RosterRowActions,
  replaceSearchParam,
  RosterStatusBadge,
  StatusFilterToggle,
  useUrlFilter,
  type RowLink,
} from "../_roster/roster-ui";
import {
  matchesLinkFilter,
  type EmailChange,
  type Health,
  type LinkFilter,
  type LinkInfo,
  type StatusFilter,
  type TypeFilter,
} from "../_roster/types";
import { SupplierDialog, type SupplierFormData } from "./supplier-dialog";

export type SupplierTableRow = SupplierFormData & {
  status: "active" | "withdrawn";
  appointmentCount: number;
  health: Health;
  healthHint?: string;
  adminLink: LinkInfo;
  attendeeLink: LinkInfo;
  /** Either contact's schedule changed since their last email. */
  emailChange: EmailChange;
};

const TYPE_LABELS = { business: "Business", hotel: "Hotel" } as const;

const helper = createDataTableColumnHelper<SupplierTableRow>();

export function AddSupplierButton({ eventId, disabled }: { eventId: string; disabled: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={disabled}>
        <PlusIcon data-icon="inline-start" />
        Add supplier
      </Button>
      <SupplierDialog eventId={eventId} supplier={null} open={open} onOpenChange={setOpen} />
    </>
  );
}

function Contact({ role, name, email }: { role: string; name: string | null; email: string | null }) {
  if (!name && !email) return <span className="text-muted-foreground">No {role.toLowerCase()} contact</span>;
  return (
    <span className="flex flex-col">
      <span>
        <span className="text-muted-foreground">{role}: </span>
        {name ?? email}
      </span>
      {name && email ? <span className="text-xs text-muted-foreground">{email}</span> : null}
    </span>
  );
}

/** Only contacts with an email can hold a link, so only those get a badge and menu items. */
function rowLinks(row: SupplierTableRow): (RowLink & { short: string })[] {
  const links: (RowLink & { short: string })[] = [];
  if (row.adminContactEmail) links.push({ label: "admin contact link", short: "Admin", link: row.adminLink });
  if (row.attendeeContactEmail) links.push({ label: "attendee contact link", short: "Attendee", link: row.attendeeLink });
  return links;
}

type SuppliersTableProps = {
  eventId: string;
  rows: SupplierTableRow[];
  lockedReason: string | null;
  linksBlockedReason: string | null;
  importsHref: string;
  initialStatus: StatusFilter;
  initialType: TypeFilter;
  initialLink: LinkFilter;
  initialQuery: string;
};

export function SuppliersTable({
  eventId,
  rows,
  lockedReason,
  linksBlockedReason,
  importsHref,
  initialStatus,
  initialType,
  initialLink,
  initialQuery,
}: SuppliersTableProps) {
  const [status, setStatus] = useUrlFilter<StatusFilter>("status", initialStatus, "active");
  const [type, setType] = useUrlFilter<TypeFilter>("type", initialType, "all");
  const [link, setLink] = useUrlFilter<LinkFilter>("link", initialLink, "all");
  const [editing, setEditing] = React.useState<SupplierTableRow | null>(null);

  const visible = React.useMemo(
    () =>
      rows.filter(
        (row) =>
          (status === "all" || row.status === status) &&
          (type === "all" || row.type === type) &&
          matchesLinkFilter(link, rowLinks(row).map((entry) => entry.link)),
      ),
    [rows, status, type, link],
  );

  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Name",
          sortFn: "name",
          ...NAME_COLUMN,
          cell: ({ row }) => <span className="font-medium wrap-anywhere">{row.original.name}</span>,
        }),
        helper.accessor((row) => TYPE_LABELS[row.type], {
          id: "type",
          header: "Type",
          cell: ({ row }) => <Badge variant="outline">{TYPE_LABELS[row.original.type]}</Badge>,
        }),
        helper.accessor((row) => row.deskNumber ?? 0, {
          id: "desk",
          header: "Desk",
          sortFn: "basic",
          cell: ({ row }) =>
            row.original.deskNumber === null ? (
              <span className="text-muted-foreground" title="Assigned when the schedule is locked.">
                –<span className="sr-only">Not assigned</span>
              </span>
            ) : (
              <span className="tabular-nums" title={row.original.deskOverride ? "Set by hand" : "Assigned at lock"}>
                {row.original.deskNumber}
                {row.original.deskOverride ? <span className="text-muted-foreground"> (set)</span> : null}
              </span>
            ),
        }),
        helper.accessor(
          (row) =>
            [row.adminContactName, row.adminContactEmail, row.attendeeContactName, row.attendeeContactEmail]
              .filter(Boolean)
              .join(" "),
          {
            id: "contacts",
            header: "Contacts",
            enableSorting: false,
            meta: { className: "whitespace-normal" },
            cell: ({ row }) => (
              <div className="flex min-w-36 flex-col gap-1 text-sm wrap-anywhere">
                <Contact role="Admin" name={row.original.adminContactName} email={row.original.adminContactEmail} />
                <Contact role="Attendee" name={row.original.attendeeContactName} email={row.original.attendeeContactEmail} />
              </div>
            ),
          },
        ),
        helper.accessor("appointmentCount", {
          header: "Appointments",
          sortFn: "basic",
          cell: ({ row }) => (
            <AppointmentCount
              count={row.original.appointmentCount}
              health={row.original.health}
              hint={row.original.healthHint}
            />
          ),
        }),
        helper.display({
          id: "links",
          header: "Links",
          cell: ({ row }) => {
            const links = rowLinks(row.original);
            if (links.length === 0) return <span className="text-muted-foreground">No contact emails</span>;
            return (
              <div className="flex flex-col items-start gap-1">
                {links.map((entry) => (
                  <LinkBadge key={entry.short} link={entry.link} prefix={entry.short} />
                ))}
              </div>
            );
          },
        }),
        helper.accessor((row) => row.emailChange ?? "", {
          id: "emailChange",
          header: "Changed since last email",
          // The long header wraps instead of widening the table.
          meta: { className: "whitespace-normal" },
          cell: ({ row }) => <EmailChangeBadge state={row.original.emailChange} />,
        }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ row }) => <RosterStatusBadge status={row.original.status} />,
        }),
        helper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          enableSorting: false,
          meta: { className: ACTIONS_COLUMN_CLASS },
          cell: ({ row }) => {
            const item = row.original;
            return (
              <RosterRowActions
                name={item.name}
                withdrawn={item.status === "withdrawn"}
                lockedReason={lockedReason}
                linksBlockedReason={linksBlockedReason}
                onEdit={() => setEditing(item)}
                withdraw={() => withdrawSupplierAction(item.id)}
                restore={() => restoreSupplierAction(item.id)}
                links={rowLinks(item)}
              />
            );
          },
        }),
      ]),
    [lockedReason, linksBlockedReason],
  );

  const hasRows = rows.length > 0;
  return (
    <>
      <DataTable
        columns={columns}
        data={visible}
        searchColumns={["name", "contacts"]}
        searchPlaceholder="Search by name or contact"
        initialSearch={initialQuery}
        onSearchChange={replaceSearchParam}
        getRowId={(row) => row.id}
        rowClassName={(row) => (row.status === "withdrawn" ? "text-muted-foreground" : undefined)}
        emptyTitle={hasRows ? "No suppliers match these filters" : "No suppliers yet"}
        emptyDescription={
          hasRows
            ? "Clear the search or change the status, type, or link filter to see more."
            : "Upload the suppliers file on the Imports page, or add suppliers one at a time."
        }
        emptyAction={
          hasRows ? null : (
            <Button variant="outline" asChild>
              <Link href={importsHref}>Go to imports</Link>
            </Button>
          )
        }
      >
        <StatusFilterToggle value={status} onChange={setStatus} />
        <Select value={type} onValueChange={(value) => setType(value as TypeFilter)}>
          <SelectTrigger size="sm" aria-label="Supplier type" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="hotel">Hotel</SelectItem>
              <SelectItem value="business">Business</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <LinkFilterSelect value={link} onChange={setLink} />
      </DataTable>
      <SupplierDialog
        eventId={eventId}
        supplier={editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </>
  );
}
