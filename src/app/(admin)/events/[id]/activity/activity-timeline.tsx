import { cn } from "cn";
import {
  ArrowLeftRightIcon,
  ChevronDownIcon,
  DownloadIcon,
  FileUpIcon,
  HistoryIcon,
  LockIcon,
  MailIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
  ShuffleIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AuditActionGroup } from "@/server/audit/describe";
import type { ActivityDetail, ActivityRow } from "@/server/audit/queries";
import { entryTone, type DayGroup, type EntryTone } from "./activity-view";
import { UndoButton } from "./undo-button";

const AREA_ICONS: Record<AuditActionGroup, LucideIcon> = {
  schedule: ArrowLeftRightIcon,
  roster: UsersRoundIcon,
  imports: FileUpIcon,
  matching: ShuffleIcon,
  lock: LockIcon,
  emails: MailIcon,
  exports: DownloadIcon,
  settings: SettingsIcon,
};

/** Actions that take the area icon's place because the area icon says nothing about them. */
const ACTION_ICONS: Partial<Record<string, LucideIcon>> = {
  "appointment.pin": PinIcon,
  "appointment.unpin": PinOffIcon,
};

const TONE_CLASSES: Record<EntryTone, string> = {
  schedule: "bg-hotel-tint text-hotel-ink",
  imports: "bg-business-tint text-business-ink",
  removal: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  quiet: "bg-muted text-muted-foreground",
};

function DetailsTable({ details }: { details: ActivityDetail[] }) {
  return (
    <div className="mt-2 max-w-xl overflow-x-auto rounded-md border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-8">Field</TableHead>
            <TableHead className="h-8">Before</TableHead>
            <TableHead className="h-8">After</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {details.map((d) => (
            <TableRow key={d.key} className="hover:bg-transparent">
              <TableCell className="py-1.5 font-medium">{d.label}</TableCell>
              <TableCell className="max-w-56 py-1.5 break-words whitespace-normal text-muted-foreground">{d.before ?? "–"}</TableCell>
              <TableCell className="max-w-56 py-1.5 break-words whitespace-normal">{d.after ?? "–"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Entry({ row }: { row: ActivityRow }) {
  const Icon = ACTION_ICONS[row.action] ?? (row.area ? AREA_ICONS[row.area] : HistoryIcon);
  // Phones: Undo drops under the text in the second column. From sm up it sits in a third column at the end of the row.
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 border-t py-3 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span className={cn("mt-0.5 grid size-8 place-items-center rounded-md", TONE_CLASSES[entryTone(row)])} aria-hidden="true">
        <Icon className="size-4" />
      </span>
      <Collapsible className="group/details flex min-w-0 flex-col gap-0.5">
        <p className="font-medium text-pretty break-words">{row.sentence}</p>
        {row.note ? <p className="text-sm text-muted-foreground">{row.note}</p> : null}
        <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span>{row.who}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{row.time}</span>
          {row.details.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <CollapsibleTrigger asChild>
                <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground">
                  Details
                  <ChevronDownIcon
                    data-icon="inline-end"
                    className="transition-transform group-data-[state=open]/details:rotate-180 motion-reduce:transition-none"
                  />
                </Button>
              </CollapsibleTrigger>
            </>
          ) : null}
        </div>
        {row.details.length > 0 ? (
          <CollapsibleContent>
            <DetailsTable details={row.details} />
          </CollapsibleContent>
        ) : null}
      </Collapsible>
      {row.undo ? (
        <div className="col-start-2 mt-2 flex justify-start sm:col-start-3 sm:mt-0 sm:justify-end">
          <UndoButton auditEventId={row.id} sentence={row.sentence} undo={row.undo} />
        </div>
      ) : null}
    </li>
  );
}

/** The log grouped by day in the event's timezone, newest first. */
export function ActivityTimeline({ groups }: { groups: DayGroup<ActivityRow>[] }) {
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.day} aria-labelledby={`day-${group.day}`} className="flex flex-col gap-2">
          <h2 id={`day-${group.day}`} className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
            {group.label}
            {group.label !== group.date ? <span className="font-normal text-muted-foreground">{group.date}</span> : null}
          </h2>
          <ol className="rounded-lg border bg-card px-4">
            {group.rows.map((row) => (
              <Entry key={row.id} row={row} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
