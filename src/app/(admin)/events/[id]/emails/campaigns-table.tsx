"use client";

import * as React from "react";
import Link from "next/link";
import { createDataTableColumnHelper, DataTable } from "@/components/app/data-table";
import type { EmailAudience, EmailCampaignKind } from "@/lib/schemas/email";
import { AUDIENCE_LABELS, CampaignStatusBadge, KIND_LABELS, type CampaignStatus } from "./labels";

export type CampaignTableRow = {
  id: string;
  href: string;
  name: string;
  kind: EmailCampaignKind;
  audience: EmailAudience;
  status: CampaignStatus;
  recipients: number | null;
  sent: number;
  delivered: number;
  bounced: number;
  /** Formatted in the event timezone on the server. */
  sentAt: string | null;
  /** For sorting. */
  sentAtTime: number;
};

const helper = createDataTableColumnHelper<CampaignTableRow>();

function Count({ value, muted }: { value: number; muted: boolean }) {
  return <span className={muted ? "text-muted-foreground tabular-nums" : "tabular-nums"}>{value}</span>;
}

export function CampaignsTable({ rows }: { rows: CampaignTableRow[] }) {
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Name",
          cell: ({ row }) => (
            <Link href={row.original.href} className="block max-w-xs font-medium whitespace-normal underline-offset-4 hover:underline">
              {row.original.name}
            </Link>
          ),
        }),
        helper.accessor((row) => KIND_LABELS[row.kind], { id: "kind", header: "Kind" }),
        helper.accessor((row) => AUDIENCE_LABELS[row.audience], { id: "audience", header: "Audience" }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ row }) => <CampaignStatusBadge status={row.original.status} />,
        }),
        helper.accessor((row) => row.recipients ?? 0, {
          id: "recipients",
          header: "Recipients",
          sortFn: "basic",
          cell: ({ row }) =>
            row.original.recipients === null ? (
              <span className="text-muted-foreground">–</span>
            ) : (
              <span className="tabular-nums">{row.original.recipients}</span>
            ),
        }),
        helper.accessor("sent", {
          header: "Sent",
          sortFn: "basic",
          cell: ({ row }) => <Count value={row.original.sent} muted={row.original.sent === 0} />,
        }),
        helper.accessor("delivered", {
          header: "Delivered",
          sortFn: "basic",
          cell: ({ row }) => <Count value={row.original.delivered} muted={row.original.delivered === 0} />,
        }),
        helper.accessor("bounced", {
          header: "Bounced",
          sortFn: "basic",
          cell: ({ row }) =>
            row.original.bounced > 0 ? (
              <span className="font-medium text-destructive tabular-nums">{row.original.bounced}</span>
            ) : (
              <Count value={0} muted />
            ),
        }),
        helper.accessor("sentAtTime", {
          id: "sentAt",
          header: "Sent at",
          sortFn: "basic",
          cell: ({ row }) => row.original.sentAt ?? <span className="text-muted-foreground">Not sent</span>,
        }),
      ]),
    [],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      emptyTitle="No campaigns yet"
      emptyDescription="Create a campaign to email every buyer and supplier contact their private schedule link."
    />
  );
}
