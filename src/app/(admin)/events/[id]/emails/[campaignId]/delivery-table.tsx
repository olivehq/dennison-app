"use client";

import * as React from "react";
import { RefreshCwIcon, RotateCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { createDataTableColumnHelper, DataTable } from "@/components/app/data-table";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { resendToBouncedAction } from "@/server/email/actions";
import {
  MESSAGE_STATUS_LABELS,
  MessageStatusBadge,
  recipients,
  sentMessage,
  skippedRevokedMessage,
  type MessageStatus,
} from "../labels";

export type DeliveryTableRow = {
  id: string;
  name: string;
  email: string;
  status: MessageStatus;
  /** "Delivered, Nov 2, 3:10 PM", formatted on the server in the event timezone. */
  lastEvent: string | null;
  reason: string | null;
  attempts: number;
};

const helper = createDataTableColumnHelper<DeliveryTableRow>();

const NOTHING_TO_RETRY = "Nothing to retry. No email has bounced or failed.";

const STATUS_OPTIONS: MessageStatus[] = ["queued", "sent", "delivered", "bounced", "complained", "failed"];

export function DeliveryTable({ rows }: { rows: DeliveryTableRow[] }) {
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Recipient",
          sortFn: "name",
          cell: ({ row }) => (
            <div className="flex max-w-md min-w-48 flex-col whitespace-normal">
              <span className="font-medium">{row.original.name}</span>
              {row.original.attempts > 1 ? (
                <span className="text-xs text-muted-foreground">Sent {row.original.attempts} times</span>
              ) : null}
            </div>
          ),
        }),
        helper.accessor("email", { header: "Email" }),
        helper.accessor("status", {
          header: "Status",
          filterFn: "equalsString",
          cell: ({ row }) => <MessageStatusBadge status={row.original.status} />,
        }),
        helper.accessor((row) => row.lastEvent ?? "", {
          id: "lastEvent",
          header: "Last event",
          enableSorting: false,
          cell: ({ row }) => row.original.lastEvent ?? <span className="text-muted-foreground">None yet</span>,
        }),
        helper.accessor((row) => row.reason ?? "", {
          id: "reason",
          header: "Bounce reason",
          enableSorting: false,
          cell: ({ row }) =>
            row.original.reason ? <span className="block max-w-80 whitespace-normal">{row.original.reason}</span> : null,
        }),
      ]),
    [],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      searchColumns={["name", "email"]}
      searchPlaceholder="Search by name or email"
      emptyTitle="No messages"
      emptyDescription="Messages appear here once the campaign is sent."
    >
      {(table) => {
        const column = table.getColumn("status");
        const value = (column?.getFilterValue() as string | undefined) ?? "all";
        return (
          <Select value={value} onValueChange={(next) => column?.setFilterValue(next === "all" ? undefined : next)}>
            <SelectTrigger size="sm" aria-label="Delivery status" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_OPTIONS.map((status) => (
                  <SelectItem key={status} value={status}>
                    {MESSAGE_STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        );
      }}
    </DataTable>
  );
}

export function RetryDeliveryButton({
  campaignId,
  count,
  disabledReason,
}: {
  campaignId: string;
  /** Recipients whose latest message bounced or failed, plus, for a failed campaign, those it never reached. */
  count: number;
  disabledReason: string | null;
}) {
  const router = useRouter();
  // Nothing to retry is the plainer fact, so it wins over a setup problem that would only matter later.
  const reason = count === 0 ? NOTHING_TO_RETRY : disabledReason;
  const trigger = (
    <Button variant="outline" disabled={reason !== null} title={reason ?? undefined}>
      <RotateCwIcon data-icon="inline-start" />
      Retry delivery
    </Button>
  );
  // A visible reason, not only a tooltip: keyboard and touch users can't hover a disabled button.
  if (reason !== null) {
    return (
      <div className="flex flex-col items-end gap-1">
        {trigger}
        <p className="max-w-xs text-right text-xs text-muted-foreground">{reason}</p>
      </div>
    );
  }

  return (
    <ConfirmDialog
      title={`Retry delivery to ${recipients(count)}?`}
      description="Sends this campaign again to everyone whose last email bounced, failed, or never went out, at the address on the roster now. Fix any wrong addresses on the Participants or Suppliers page first."
      confirmLabel="Retry delivery"
      destructive
      onConfirm={async () => {
        const result = await resendToBouncedAction({ campaignId });
        if (!result.ok) {
          toast.error(result.error.message);
          router.refresh();
          return;
        }
        const notify = result.data.delivered ? toast.success : toast.warning;
        notify(sentMessage(result.data.sent, result.data.delivered));
        if (result.data.failed > 0) toast.error(`${recipients(result.data.failed)} could not be sent.`);
        if (result.data.skippedRevoked > 0) toast.warning(skippedRevokedMessage(result.data.skippedRevoked));
      }}
      trigger={trigger}
    />
  );
}

/** Delivery statuses change as Resend reports them; the page only shows what it loaded, so this loads it again. */
export function RefreshStatusButton() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const requested = React.useRef(false);

  // The refresh is done when the transition ends, so say so then, not when the click lands.
  React.useEffect(() => {
    if (pending || !requested.current) return;
    requested.current = false;
    toast.success("Status updated.");
  }, [pending]);

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => {
        requested.current = true;
        startTransition(() => router.refresh());
      }}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
      {pending ? "Refreshing" : "Refresh status"}
    </Button>
  );
}
