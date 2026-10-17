"use client";

import * as React from "react";
import { MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { createDataTableColumnHelper, DataTable } from "@/components/app/data-table";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { importStateSchema, isRankingKind, type ImportKind, type ImportState } from "@/lib/schemas/import";
import { deleteImport } from "@/server/imports/actions";
import { replaceSearchParam, useUrlFilter } from "../_roster/roster-ui";
import { filterHistory, type HistoryFilters } from "./history-filters";
import { setImportIgnored } from "./ignore-toggle";
import { ImportStateBadge, importHref, KIND_LABELS, plural, STATE_LABELS } from "./import-labels";

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
      ? "The rankings this file wrote are removed too, so the people in it lose them. Rankings it replaced when it was applied don't come back. Everyone else keeps their rankings."
      : "It was never applied, so no rankings change.";
  }
  return row.state === "applied"
    ? "People it added or updated stay on the roster. Only the import record and its report go."
    : "It was never applied, so the roster doesn't change.";
}

/** The row menu: ignore or stop ignoring a file that isn't applied, and delete. */
function ImportRowActions({ row, lockedReason }: { row: HistoryRow; lockedReason: string | null }) {
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const locked = lockedReason !== null;
  const ignored = row.state === "ignored";

  const toggleIgnored = () => {
    startTransition(async () => {
      await setImportIgnored(row.id, row.fileName, !ignored);
    });
  };

  return (
    // Clicks inside the menu and dialog bubble through the portal to the row; stop them here.
    <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.fileName}`} disabled={pending}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {locked ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel className="max-w-64 font-normal text-muted-foreground">{lockedReason}</DropdownMenuLabel>
            </DropdownMenuGroup>
          ) : null}
          <DropdownMenuGroup>
            {row.state !== "applied" ? (
              <DropdownMenuItem disabled={locked} onSelect={toggleIgnored}>
                {ignored ? "Stop ignoring" : "Ignore file"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={locked} variant="destructive" onSelect={() => setConfirmDelete(true)}>
              Delete import
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${row.fileName}?`}
        description={deleteDescription(row)}
        confirmLabel="Delete import"
        destructive
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
        }}
      />
    </div>
  );
}

/** Links from History carry `from=history`, so the import page's back link returns here. */
function reportHref(eventId: string, importId: string): string {
  return `${importHref(eventId, importId)}?from=history`;
}

export function ImportHistoryTable({
  eventId,
  rows,
  lockedReason,
  initialFilters,
  uploadHref,
}: {
  eventId: string;
  rows: HistoryRow[];
  lockedReason: string | null;
  initialFilters: HistoryFilters;
  uploadHref: string;
}) {
  const router = useRouter();
  const [type, setType] = useUrlFilter<HistoryFilters["type"]>("type", initialFilters.type, "all");
  const [state, setState] = useUrlFilter<HistoryFilters["state"]>("state", initialFilters.state, "all");
  const visible = React.useMemo(() => filterHistory(rows, { type, state }), [rows, type, state]);
  const filtered = type !== "all" || state !== "all";
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("fileName", {
          header: "File",
          cell: ({ row }) => (
            <Link
              href={reportHref(eventId, row.original.id)}
              className="font-medium break-all underline-offset-4 hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {row.original.fileName}
            </Link>
          ),
        }),
        helper.accessor((row) => KIND_LABELS[row.kind], { id: "kind", header: "File type" }),
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
          cell: ({ row }) => <ImportRowActions row={row.original} lockedReason={lockedReason} />,
        }),
      ]),
    [eventId, lockedReason],
  );

  return (
    <DataTable
      columns={columns}
      data={visible}
      searchColumns={["fileName"]}
      searchPlaceholder="Search by filename"
      initialSearch={initialFilters.q}
      onSearchChange={replaceSearchParam}
      getRowId={(row) => row.id}
      onRowClick={(row) => router.push(reportHref(eventId, row.id))}
      emptyTitle={rows.length === 0 ? "No uploads yet" : "No files match these filters"}
      emptyDescription={
        rows.length === 0 ? "Files you upload are listed here with their state." : "Change the file type or state to see more."
      }
      emptyAction={
        rows.length === 0 ? (
          <Button variant="outline" asChild>
            <Link href={uploadHref}>Go to upload</Link>
          </Button>
        ) : filtered ? (
          <Button
            variant="outline"
            onClick={() => {
              setType("all");
              setState("all");
            }}
          >
            Show all files
          </Button>
        ) : null
      }
    >
      <Select value={type} onValueChange={(value) => setType(value as HistoryFilters["type"])}>
        <SelectTrigger size="sm" aria-label="File type" className="w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All file types</SelectItem>
            {Object.entries(KIND_LABELS).map(([kind, label]) => (
              <SelectItem key={kind} value={kind}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select value={state} onValueChange={(value) => setState(value as HistoryFilters["state"])}>
        <SelectTrigger size="sm" aria-label="State" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All states</SelectItem>
            {importStateSchema.options.map((option) => (
              <SelectItem key={option} value={option}>
                {STATE_LABELS[option]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </DataTable>
  );
}
