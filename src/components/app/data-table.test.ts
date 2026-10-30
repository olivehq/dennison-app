import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createDataTableColumnHelper, DataTable, sortFn_name, type DataTableInstance } from "./data-table";

/** Just enough of a TanStack row for a sort function: it only reads the column value. */
const row = (name: string | null) => ({ getValue: () => name }) as unknown as Parameters<typeof sortFn_name>[0];

const sortNames = (names: (string | null)[]) =>
  names
    .map(row)
    .sort((a, b) => sortFn_name(a, b, "name"))
    .map((r) => r.getValue("name"));

describe("sortFn_name", () => {
  it("orders names with compareNames, ignoring case", () => {
    expect(sortNames(["Wyndham", "eShow", "ACWA", "Academic"])).toEqual(["Academic", "ACWA", "eShow", "Wyndham"]);
  });

  it("orders numbers in names by value and puts an empty name first", () => {
    expect(sortNames(["Hall 10", "Hall 2", null])).toEqual([null, "Hall 2", "Hall 10"]);
  });
});

describe("header sort direction", () => {
  type Row = { name: string; desk: number; booked: number };
  const helper = createDataTableColumnHelper<Row>();
  const data: Row[] = [
    { name: "Alpha", desk: 1, booked: 7 },
    { name: "Bravo", desk: 2, booked: 9 },
  ];
  /** Renders a real DataTable on the server and reads which way each column's first click sorts. */
  const firstDirections = (bookedOptions: { sortDescFirst?: boolean } = {}) => {
    let table: DataTableInstance<Row> | undefined;
    const columns = helper.columns([
      helper.accessor("name", { header: "Name" }),
      helper.accessor("desk", { header: "Desk" }),
      helper.accessor("booked", { header: "Booked", ...bookedOptions }),
    ]);
    renderToString(
      // DataTable takes a render function as children to hand over the table instance.
      // eslint-disable-next-line react/no-children-prop
      createElement(DataTable<Row>, {
        columns,
        data,
        children: (instance: DataTableInstance<Row>) => {
          table = instance;
          return null;
        },
      }),
    );
    return Object.fromEntries(table!.getAllColumns().map((c) => [c.id, c.getFirstSortDir()]));
  };

  it("sorts ascending first on text and number columns", () => {
    expect(firstDirections()).toEqual({ name: "asc", desk: "asc", booked: "asc" });
  });

  it("lets a column ask for descending first", () => {
    expect(firstDirections({ sortDescFirst: true })).toMatchObject({ desk: "asc", booked: "desc" });
  });
});
