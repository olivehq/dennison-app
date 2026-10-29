"use client";

import * as React from "react";
import {
  columnFilteringFeature,
  columnResizingFeature,
  columnSizingFeature,
  constructSortFn,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_equalsString,
  filterFn_includesString,
  globalFilteringFeature,
  metaHelper,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type Column,
  type ColumnDef,
  type Header,
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
import { compareNames } from "@/lib/names";

/** Per-column display options, read from `columnDef.meta`. */
export type DataTableColumnMeta = {
  /**
   * Classes for this column's header and body cells. Cells default to
   * `whitespace-nowrap`; pass `whitespace-normal` for long text that should
   * wrap, or `ACTIONS_COLUMN_CLASS` to keep a column in view when the table
   * scrolls sideways.
   */
  className?: string;
};

/**
 * `sortFn: "name"` for a column that holds a name: sorts with `compareNames`
 * (D66), so case, accents, and numbers in names order the same way as
 * everywhere else.
 */
export const sortFn_name = constructSortFn({
  resolveDataValue: (value) => (value == null ? "" : String(value)),
  sort: (a: string, b: string) => compareNames(a, b),
});

/** One feature set for every DataTable, so column defs and the instance share types. */
export const dataTableFeatures = tableFeatures({
  columnMeta: metaHelper<DataTableColumnMeta>(),
  columnSizingFeature,
  columnResizingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString, equalsString: filterFn_equalsString },
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  // Every name the "auto" sort can pick is registered, so it never falls back with a console warning.
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
    name: sortFn_name,
  },
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

/**
 * Header clicks cycle ascending then descending. Left to itself the table starts
 * a numeric column descending; the first click sorts ascending everywhere, and a
 * column can opt back in with `sortDescFirst: true` in its definition.
 */
export const DATA_TABLE_SORTING = { enableSortingRemoval: false, sortDescFirst: false } as const;

const RESIZE_KEY_STEP = 16;

/**
 * Spread into the definition of a long-text name column: it wraps instead of
 * forcing the table wider, and its width can be dragged between the limits.
 */
export const NAME_COLUMN = {
  enableResizing: true,
  size: 208,
  minSize: 144,
  maxSize: 640,
  meta: { className: "whitespace-normal" },
} as const;

/** `meta.className` for a trailing actions column that stays in view when the table scrolls sideways. */
export const ACTIONS_COLUMN_CLASS =
  "sticky right-0 bg-card group-hover/row:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))] group-has-aria-expanded/row:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))]";

/**
 * A column is resizable only when its definition sets `enableResizing: true`
 * (with `size`, `minSize`, and `maxSize`). Its header and cells then get that
 * width, so a wrapping text column can be dragged wider or narrower.
 */
function isResizable<TData extends RowData>(column: Column<DataTableFeatures, TData, unknown>): boolean {
  return column.columnDef.enableResizing === true && column.getCanResize();
}

/** The drag handle on a resizable header's right edge. Arrow keys resize it, a double click resets it. */
function ResizeHandle<TData extends RowData>({
  header,
  table,
}: {
  header: Header<DataTableFeatures, TData, unknown>;
  table: DataTableInstance<TData>;
}) {
  const { column } = header;
  const min = column.columnDef.minSize ?? 40;
  const max = column.columnDef.maxSize ?? 1000;
  const label = typeof column.columnDef.header === "string" ? column.columnDef.header : column.id;
  const resize = header.getResizeHandler();
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? RESIZE_KEY_STEP : event.key === "ArrowLeft" ? -RESIZE_KEY_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = Math.min(max, Math.max(min, column.getSize() + step));
    table.setColumnSizing((old) => ({ ...old, [column.id]: next }));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={column.getSize()}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={resize}
      onTouchStart={resize}
      onKeyDown={onKeyDown}
      onDoubleClick={() => column.resetSize()}
      className={cn(
        "absolute inset-y-0 right-0 z-10 flex w-3 cursor-col-resize touch-none items-center justify-center select-none",
        "outline-none after:h-5 after:w-0.5 after:rounded-full after:bg-border after:transition-colors",
        "hover:after:bg-primary focus-visible:after:bg-ring",
        column.getIsResizing() && "after:bg-primary",
      )}
    />
  );
}

type DataTableProps<TData extends RowData> = {
  columns: DataTableColumn<TData>[];
  data: TData[];
  /** Column ids the search box matches against. No search box when empty. */
  searchColumns?: string[];
  searchPlaceholder?: string;
  /** The search box's starting text, for example from the URL. */
  initialSearch?: string;
  /** Called on every change of the search text, for example to mirror it into the URL. */
  onSearchChange?: (value: string) => void;
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
  initialSearch = "",
  onSearchChange,
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
    initialState: { pagination: { pageIndex: 0, pageSize }, globalFilter: initialSearch },
    columnResizeMode: "onChange",
    globalFilterFn: "includesString",
    getColumnCanGlobalFilter: (column) => searchable.has(column.id),
    ...DATA_TABLE_SORTING,
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
                onChange={(event) => {
                  table.setGlobalFilter(event.target.value);
                  onSearchChange?.(event.target.value);
                }}
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
        // contain-inline-size: the table scrolls inside this box instead of its min-content width pushing the whole page wider.
        <div className="min-w-0 rounded-lg border bg-card contain-inline-size">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    const resizable = isResizable(header.column);
                    const content = header.isPlaceholder ? null : canSort ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-ml-0 h-auto min-h-10 rounded-none px-2 py-1 text-left font-medium [white-space:inherit]!"
                        onClick={header.column.getToggleSortingHandler()}
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
                    );
                    return (
                      <TableHead
                        key={header.id}
                        aria-sort={canSort ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
                        className={cn(canSort && "p-0", resizable && "relative", header.column.columnDef.meta?.className)}
                      >
                        {resizable ? <div style={{ width: header.column.getSize() }}>{content}</div> : content}
                        {resizable ? <ResizeHandle header={header} table={table} /> : null}
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
                    className={cn("group/row", onRowClick && "cursor-pointer", rowClassName?.(row.original))}
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                        {isResizable(cell.column) ? (
                          <div style={{ width: cell.column.getSize() }}>
                            <table.FlexRender cell={cell} />
                          </div>
                        ) : (
                          <table.FlexRender cell={cell} />
                        )}
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
