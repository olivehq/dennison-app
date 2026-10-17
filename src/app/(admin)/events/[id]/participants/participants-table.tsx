"use client";

import * as React from "react";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { ACTIONS_COLUMN_CLASS, createDataTableColumnHelper, DataTable, NAME_COLUMN } from "@/components/app/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { restoreParticipantAction, withdrawParticipantAction } from "@/server/roster/actions";
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
} from "../_roster/roster-ui";
import {
  matchesLinkFilter,
  type BiztechFilter,
  type EmailChange,
  type Health,
  type LinkFilter,
  type LinkInfo,
  type StatusFilter,
} from "../_roster/types";
import { ParticipantDialog, type ParticipantFormData } from "./participant-dialog";

export type ParticipantTableRow = ParticipantFormData & {
  displayLabel: string;
  /** Full name, organization, and title, minus whatever the display label already shows. */
  secondary: string;
  status: "active" | "withdrawn";
  appointmentCount: number;
  health: Health;
  healthHint?: string;
  link: LinkInfo;
  emailChange: EmailChange;
};

const helper = createDataTableColumnHelper<ParticipantTableRow>();

export function AddParticipantButton({ eventId, disabled }: { eventId: string; disabled: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={disabled}>
        <PlusIcon data-icon="inline-start" />
        Add participant
      </Button>
      <ParticipantDialog eventId={eventId} participant={null} open={open} onOpenChange={setOpen} />
    </>
  );
}

type ParticipantsTableProps = {
  eventId: string;
  rows: ParticipantTableRow[];
  lockedReason: string | null;
  linksBlockedReason: string | null;
  importsHref: string;
  initialStatus: StatusFilter;
  initialBiztech: BiztechFilter;
  initialLink: LinkFilter;
  initialQuery: string;
};

export function ParticipantsTable({
  eventId,
  rows,
  lockedReason,
  linksBlockedReason,
  importsHref,
  initialStatus,
  initialBiztech,
  initialLink,
  initialQuery,
}: ParticipantsTableProps) {
  const [status, setStatus] = useUrlFilter<StatusFilter>("status", initialStatus, "active");
  const [biztech, setBiztech] = useUrlFilter<BiztechFilter>("biztech", initialBiztech, "all");
  const [link, setLink] = useUrlFilter<LinkFilter>("link", initialLink, "all");
  const [editing, setEditing] = React.useState<ParticipantTableRow | null>(null);

  const visible = React.useMemo(
    () =>
      rows.filter(
        (row) =>
          (status === "all" || row.status === status) &&
          (biztech === "all" || row.biztechOptIn === (biztech === "in")) &&
          matchesLinkFilter(link, [row.link]),
      ),
    [rows, status, biztech, link],
  );

  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor((row) => `${row.displayLabel} ${row.secondary}`, {
          id: "name",
          header: "Name",
          sortFn: "name",
          ...NAME_COLUMN,
          cell: ({ row }) => (
            <div className="flex flex-col wrap-anywhere">
              <span className="font-medium">{row.original.displayLabel}</span>
              {row.original.secondary ? (
                <span className="text-xs text-muted-foreground">{row.original.secondary}</span>
              ) : null}
            </div>
          ),
        }),
        helper.accessor("email", { header: "Email" }),
        helper.accessor((row) => (row.biztechOptIn ? "Opted in" : "Opted out"), {
          id: "biztech",
          header: "Biztech",
          cell: ({ row }) => (
            <Badge variant={row.original.biztechOptIn ? "secondary" : "outline"}>
              {row.original.biztechOptIn ? "Opted in" : "Opted out"}
            </Badge>
          ),
        }),
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
        helper.accessor((row) => row.link?.state ?? "none", {
          id: "link",
          header: "Link",
          cell: ({ row }) => <LinkBadge link={row.original.link} />,
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
                name={item.displayLabel}
                withdrawn={item.status === "withdrawn"}
                lockedReason={lockedReason}
                linksBlockedReason={linksBlockedReason}
                onEdit={() => setEditing(item)}
                withdraw={() => withdrawParticipantAction(item.id)}
                restore={() => restoreParticipantAction(item.id)}
                links={[{ label: "link", link: item.link }]}
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
        searchColumns={["name", "email"]}
        searchPlaceholder="Search by name, organization, or email"
        initialSearch={initialQuery}
        onSearchChange={replaceSearchParam}
        getRowId={(row) => row.id}
        rowClassName={(row) => (row.status === "withdrawn" ? "text-muted-foreground" : undefined)}
        emptyTitle={hasRows ? "No participants match these filters" : "No participants yet"}
        emptyDescription={
          hasRows
            ? "Clear the search or change the status, biztech, or link filter to see more."
            : "Upload the participants file on the Imports page, or add people one at a time."
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
        <Select value={biztech} onValueChange={(value) => setBiztech(value as BiztechFilter)}>
          <SelectTrigger size="sm" aria-label="Biztech opt-in" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">Any biztech</SelectItem>
              <SelectItem value="in">Opted in</SelectItem>
              <SelectItem value="out">Opted out</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <LinkFilterSelect value={link} onChange={setLink} />
      </DataTable>
      <ParticipantDialog
        eventId={eventId}
        participant={editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </>
  );
}
