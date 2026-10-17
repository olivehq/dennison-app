"use client";

import * as React from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { createDataTableColumnHelper, DataTable } from "@/components/app/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/errors";
import { disableAdmin, enableAdmin, resendInvite, revokeInvite } from "@/server/auth/actions";
import { NO_PROVIDER_NOTE } from "./invite-admin-dialog";

export type TeamRow = {
  id: string;
  kind: "admin" | "invite";
  name: string;
  email: string;
  state: "active" | "disabled" | "invited" | "revoked";
  expiresAt: Date | null;
  expired: boolean;
  isSelf: boolean;
};

const helper = createDataTableColumnHelper<TeamRow>();

const STATE_LABELS: Record<TeamRow["state"], string> = {
  active: "Active",
  disabled: "Disabled",
  invited: "Invited",
  revoked: "Revoked",
};

function StateCell({ row }: { row: TeamRow }) {
  if (row.state === "invited" && row.expiresAt) {
    return (
      <div className="flex flex-col gap-0.5">
        <Badge variant={row.expired ? "destructive" : "secondary"}>{row.expired ? "Invite expired" : "Invited"}</Badge>
        <span className="text-xs text-muted-foreground">
          {row.expired ? "Expired" : "Link expires"} {format(row.expiresAt, "MMM d, h:mm a")}
        </span>
      </div>
    );
  }
  return <Badge variant={row.state === "active" ? "default" : "outline"}>{STATE_LABELS[row.state]}</Badge>;
}

export function TeamTable({ rows }: { rows: TeamRow[] }) {
  const run = React.useCallback(
    async (work: () => Promise<ActionResult<unknown>>, done: string) => {
      const result = await work();
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(done);
    },
    [],
  );

  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Name",
          sortFn: "name",
          cell: ({ row }) => (
            <span className="font-medium">
              {row.original.name}
              {row.original.isSelf ? <span className="ml-2 text-xs font-normal text-muted-foreground">you</span> : null}
            </span>
          ),
        }),
        helper.accessor("email", { header: "Email" }),
        helper.accessor("state", {
          header: "State",
          cell: ({ row }) => <StateCell row={row.original} />,
        }),
        helper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const item = row.original;
            // A revoked invite is final: send a new one instead.
            if (item.state === "revoked") return null;
            if (item.kind === "invite") {
              return (
                <div className="flex justify-end gap-2">
                  {item.expired ? null : (
                    <ConfirmDialog
                      title={`Revoke the invite to ${item.email}?`}
                      description="The invite link stops working right away. To invite them again, send a new invite."
                      confirmLabel="Revoke invite"
                      destructive
                      trigger={
                        <Button variant="outline" size="sm">
                          Revoke invite
                        </Button>
                      }
                      onConfirm={() => run(() => revokeInvite(item.id), `Invite to ${item.email} revoked.`)}
                    />
                  )}
                  <ConfirmDialog
                    title={`Resend the invite to ${item.email}?`}
                    description="The old link stops working and a fresh one goes out, good for 7 days."
                    confirmLabel="Resend invite"
                    trigger={
                      <Button variant="outline" size="sm">
                        Resend invite
                      </Button>
                    }
                    onConfirm={async () => {
                      const result = await resendInvite(item.id);
                      if (!result.ok) {
                        toast.error(result.error.message);
                        return;
                      }
                      if (result.data.delivered) toast.success(`Invite resent to ${item.email}.`);
                      else toast.warning(`Invite logged, not sent. ${NO_PROVIDER_NOTE}`);
                    }}
                  />
                </div>
              );
            }
            if (item.state === "disabled") {
              return (
                <div className="flex justify-end">
                  <ConfirmDialog
                    title={`Enable ${item.name}?`}
                    description="They can sign in again with their existing password."
                    confirmLabel="Enable"
                    trigger={
                      <Button variant="outline" size="sm">
                        Enable
                      </Button>
                    }
                    onConfirm={() => run(() => enableAdmin(item.id), `${item.name} can sign in again.`)}
                  />
                </div>
              );
            }
            if (item.isSelf) return null;
            return (
              <div className="flex justify-end">
                <ConfirmDialog
                  title={`Disable ${item.name}?`}
                  description="They are signed out everywhere, invites they sent stop working, and they can't sign in until someone enables them again."
                  confirmLabel="Disable"
                  destructive
                  trigger={
                    <Button variant="outline" size="sm">
                      Disable
                    </Button>
                  }
                  onConfirm={() => run(() => disableAdmin(item.id), `${item.name} is disabled.`)}
                />
              </div>
            );
          },
          enableSorting: false,
        }),
      ]),
    [run],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchColumns={["name", "email"]}
      searchPlaceholder="Search by name or email"
      getRowId={(row) => `${row.kind}-${row.id}`}
      emptyTitle="No admins yet"
      emptyDescription="Invite a colleague to share the work."
    />
  );
}
