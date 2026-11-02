import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** One slot as the participant page shows it: a counterpart's name and desk, never a rank (scope 2.6). */
export type ScheduleRow = {
  slot: number;
  start: string;
  end: string;
  appointment: { counterpartName: string; desk: number | null } | null;
};

/**
 * A person's slots in order, open ones included. A buyer sees each supplier's
 * desk; a supplier's own desk is in the header, so that column is left out.
 * Server-safe.
 */
export function ScheduleTable({ rows, showDesk }: { rows: ScheduleRow[]; showDesk: boolean }) {
  return (
    <div className="rounded-lg border bg-card print:border-0">
      <Table data-slot="schedule-table">
        <caption className="sr-only">Schedule, {rows.length} slots</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="hidden w-20 pl-5 sm:table-cell">Slot</TableHead>
            <TableHead className="w-36 pl-4 sm:w-52 sm:pl-2">Time</TableHead>
            <TableHead>Meeting with</TableHead>
            {showDesk ? <TableHead className="w-20 pr-4 text-right sm:w-28 sm:pr-5">Desk</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.slot} className="h-14 hover:bg-transparent">
              <TableCell className="hidden pl-5 text-muted-foreground tabular-nums sm:table-cell">{row.slot}</TableCell>
              <TableCell className="pl-4 font-display font-bold tabular-nums sm:pl-2">
                {row.start}
                <span className="block text-xs font-normal text-muted-foreground sm:inline sm:text-sm sm:font-bold sm:text-foreground">
                  {" "}
                  to {row.end}
                </span>
              </TableCell>
              {row.appointment ? (
                <TableCell className="text-base font-bold whitespace-normal">{row.appointment.counterpartName}</TableCell>
              ) : (
                <TableCell className="text-muted-foreground italic">Open</TableCell>
              )}
              {showDesk ? (
                <TableCell className="pr-4 text-right font-semibold tabular-nums sm:pr-5">{row.appointment?.desk ?? ""}</TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
