"use client";

import * as React from "react";
import { Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { createDataTableColumnHelper, DataTable } from "@/components/app/data-table";
import { Button } from "@/components/ui/button";
import { isRankingKind, type ImportKind, type ImportState } from "@/lib/schemas/import";
import { deleteImport } from "@/server/imports/actions";
import { ImportStateBadge, importHref, KIND_LABELS, plural } from "./import-labels";

export type HistoryRow = {
  id: string;
  fileName: string;
  kind: ImportKind;
  state: ImportState;
  rows: number | null;
  uploadedBy: string;
  uploadedAt: number;
  uploadedLabel: string;
};

const helper = createDataTableColumnHelper<HistoryRow>();

function deleteDescription(row: HistoryRow): string {
  if (isRankingKind(row.kind)) {
    return row.state === "applied"
      ? "The rankings this file wrote are removed too. Matching can't run until another file of this kind is applied."
      : "It was never applied, so no rankings change.";
  }
  return row.state === "applied"
    ? "People it added or updated stay on the roster. Only the import record and its report go."
    : "It was never applied, so the roster doesn't change.";
}

function DeleteImportButton({ row, lockedReason }: { row: HistoryRow; lockedReason: string | null }) {
  const router = useRouter();
  return (
    // Clicks inside the dialog bubble through the portal to the row; stop them here.
    <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
      <ConfirmDialog
        title={`Delete ${row.fileName}?`}
        description={deleteDescription(row)}
        confirmLabel="Delete import"
        destructive
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${row.fileName}`}
            disabled={lockedReason !== null}
            title={lockedReason ?? undefined}
          >
            <Trash2Icon />
          </Button>
        }
        onConfirm={async () => {
          const result = await deleteImport(row.id);
          if (!result.ok) {
            toast.error(result.error.message);
            return;
          }
          toast.success(
            result.data.rankingsDeleted > 0
              ? `${row.fileName} deleted with ${plural(result.data.rankingsDeleted, "ranking")}.`
              : `${row.fileName} deleted.`,
          );
          router.refresh();
        }}
      />
    </div>
  );
}

export function ImportHistoryTable({
  eventId,
  rows,
  lockedReason,
}: {
  eventId: string;
  rows: HistoryRow[];
  lockedReason: string | null;
}) {
  const router = useRouter();
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("fileName", {
          header: "File",
          cell: ({ row }) => (
            <Link
              href={importHref(eventId, row.original.id)}
              className="font-medium break-all underline-offset-4 hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {row.original.fileName}
            </Link>
          ),
        }),
        helper.accessor((row) => KIND_LABELS[row.kind], { id: "kind", header: "Kind" }),
        helper.accessor("state", {
          header: "State",
          cell: ({ row }) => <ImportStateBadge state={row.original.state} />,
        }),
        helper.accessor((row) => row.rows ?? 0, {
          id: "rows",
          header: "Rows",
          sortFn: "basic",
          cell: ({ row }) => <span className="tabular-nums">{row.original.rows ?? "–"}</span>,
        }),
        helper.accessor("uploadedBy", { header: "Uploaded by" }),
        helper.accessor("uploadedAt", {
          header: "When",
          sortFn: "basic",
          cell: ({ row }) => <span className="whitespace-nowrap">{row.original.uploadedLabel}</span>,
        }),
        helper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          enableSorting: false,
          cell: ({ row }) => <DeleteImportButton row={row.original} lockedReason={lockedReason} />,
        }),
      ]),
    [eventId, lockedReason],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchColumns={["fileName", "kind"]}
      searchPlaceholder="Search by file or kind"
      getRowId={(row) => row.id}
      onRowClick={(row) => router.push(importHref(eventId, row.id))}
      emptyTitle="No uploads yet"
      emptyDescription="Files you upload above are listed here with their state."
    />
  );
}
