"use client";

import * as React from "react";
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_equalsString,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";
import { cn } from "cn";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, InboxIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** One feature set for every DataTable, so column defs and the instance share types. */
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString, equalsString: filterFn_equalsString },
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type DataTableFeatures = typeof dataTableFeatures;
export type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData, unknown>;
export type DataTableInstance<TData extends RowData> = ReturnType<typeof useTable<DataTableFeatures, TData>>;

/** Build columns with `helper.accessor` and `helper.display`, then wrap them in `helper.columns([...])`. */
export function createDataTableColumnHelper<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

export const DATA_TABLE_PAGE_SIZE = 50;

type DataTableProps<TData extends RowData> = {
  columns: DataTableColumn<TData>[];
  data: TData[];
  /** Column ids the search box matches against. No search box when empty. */
  searchColumns?: string[];
  searchPlaceholder?: string;
  /** Extra filter controls for the toolbar. A function receives the table so it can set column filters. */
  children?: React.ReactNode | ((table: DataTableInstance<TData>) => React.ReactNode);
  emptyTitle?: React.ReactNode;
  emptyDescription?: React.ReactNode;
  /** Rendered under the empty description, usually the "Create" button. */
  emptyAction?: React.ReactNode;
  onRowClick?: (row: TData) => void;
  /** Extra classes per row, for example muting withdrawn people. */
  rowClassName?: (row: TData) => string | undefined;
  getRowId?: (row: TData, index: number) => string;
  pageSize?: number;
  className?: string;
};

const EMPTY_SEARCH: string[] = [];

export function DataTable<TData extends RowData>({
  columns,
  data,
  searchColumns = EMPTY_SEARCH,
  searchPlaceholder = "Search",
  children,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyAction,
  onRowClick,
  rowClassName,
  getRowId,
  pageSize = DATA_TABLE_PAGE_SIZE,
  className,
}: DataTableProps<TData>) {
  const searchable = React.useMemo(() => new Set(searchColumns), [searchColumns]);
  const table = useTable<DataTableFeatures, TData>({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
    initialState: { pagination: { pageIndex: 0, pageSize } },
    globalFilterFn: "includesString",
    getColumnCanGlobalFilter: (column) => searchable.has(column.id),
    enableSortingRemoval: false,
  });

  const rows = table.getRowModel().rows;
  const total = table.getRowCount();
  const filtered = table.getFilteredRowModel().rows.length;
  const { pageIndex } = table.state.pagination;
  const first = filtered === 0 ? 0 : pageIndex * pageSize + 1;
  const last = Math.min(filtered, (pageIndex + 1) * pageSize);
  const globalFilter = (table.state.globalFilter as string | undefined) ?? "";
  const showToolbar = searchColumns.length > 0 || children !== undefined;
  const filterControls = typeof children === "function" ? children(table) : children;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {searchColumns.length > 0 ? (
            <InputGroup className="max-w-sm flex-1 basis-56">
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={globalFilter}
                onChange={(event) => table.setGlobalFilter(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
              />
            </InputGroup>
          ) : null}
          {filterControls}
        </div>
      ) : null}

      {total === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            {emptyDescription ? <EmptyDescription>{emptyDescription}</EmptyDescription> : null}
          </EmptyHeader>
          {emptyAction ? <EmptyContent>{emptyAction}</EmptyContent> : null}
        </Empty>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <TableHead key={header.id} className={cn(canSort && "p-0")}>
                        {header.isPlaceholder ? null : canSort ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="-ml-0 h-10 rounded-none px-2 font-medium"
                            onClick={header.column.getToggleSortingHandler()}
                            aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                          >
                            <table.FlexRender header={header} />
                            {sorted === "asc" ? (
                              <ArrowUpIcon data-icon="inline-end" />
                            ) : sorted === "desc" ? (
                              <ArrowDownIcon data-icon="inline-end" />
                            ) : (
                              <ArrowUpDownIcon data-icon="inline-end" className="text-muted-foreground" />
                            )}
                          </Button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                    No rows match. Clear the search or filters to see everything.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn(onRowClick && "cursor-pointer", rowClassName?.(row.original))}
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {filtered > pageSize ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <p aria-live="polite">
            Showing {first} to {last} of {filtered}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
