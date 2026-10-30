import { AlertTriangleIcon, ChevronDownIcon, ChevronUpIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMinutes, formatTimestamp } from "@/lib/time";
import { isEventEditable } from "@/server/events/editable";
import { requireSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import {
  activationPreviews,
  compareRunForPage,
  listRuns,
  type ActivationPreview,
  type ActivationPreviews,
  type CompareTarget,
  type RunComparisonView,
  type RunSummary,
} from "@/server/matching/queries";
import { getMatchingGate } from "@/server/matching/readiness";
import type { AppointmentView, RunComparison } from "@/server/matching/runs";
import { eventSectionHref } from "../event-sections";
import { ActivateRunButton, RunMatchingButtons } from "./run-actions";

const STATUS_LABEL: Record<RunSummary["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

/** Rows shown per list in a comparison before "and N more"; `?all=1` lifts it. */
const COMPARE_LIMIT = 40;

function duration(ms: number | null): string {
  if (ms === null) return "–";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const COMPARE_LABEL: Record<CompareTarget, string> = {
  parent: "the run it kept from",
  active: "the active run",
};

export default async function MatchingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ compare?: string | string[]; against?: string | string[]; all?: string | string[] }>;
}) {
  await requireSession();
  const [{ id }, { compare, against, all }] = await Promise.all([params, searchParams]);
  const event = await getEvent(id);
  if (!event) notFound();
  const [gate, runs, previews] = await Promise.all([getMatchingGate(event.id), listRuns(event.id), activationPreviews(event.id)]);
  const readiness = gate.counts;
  const active = runs.find((r) => r.isActive) ?? null;
  const compareId =
    typeof compare === "string" && runs.some((r) => r.id === compare && !r.isActive && r.status === "completed") ? compare : null;
  const target: CompareTarget | undefined = against === "active" || against === "parent" ? against : undefined;
  const showAll = all === "1";
  const comparison = compareId ? await compareRunForPage(event.id, compareId, target) : null;
  const editable = isEventEditable(event);
  const topN = event.settings.mutualTopN;
  const base = eventSectionHref(event.id, "matching");
  // Slot start times as set now, in the event's timezone (D16); a slot the settings no longer have shows a dash.
  const slotTimes = new Map(event.settings.slots.map((slot) => [slot.n, formatMinutes(slot.startMinutes)]));

  return (
    <>
      <PageHeader
        title="Matching"
        description="The engine builds a schedule from the rankings. Every run is kept, so you can compare and pick the one to use."
        actions={<RunMatchingButtons eventId={event.id} hasActiveRun={active !== null} disabled={!editable || !gate.ready} />}
      />

      {!editable ? (
        <Alert>
          <LockIcon />
          <AlertTitle>{event.status === "archived" ? "This event is archived" : "The schedule is locked"}</AlertTitle>
          <AlertDescription>
            {event.status === "archived" ? (
              "Runs can't be started or activated."
            ) : (
              <>
                Unlock it on the{" "}
                <Link className="underline underline-offset-4" href={eventSectionHref(event.id, "schedule")}>
                  Schedule page
                </Link>{" "}
                to run matching or activate a different run.
              </>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="font-display text-lg font-bold">{gate.ready ? "Ready to match" : "Not ready to match"}</CardTitle>
          <CardDescription>Active people and the rankings loaded for them. Withdrawn people are left out.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Buyers", value: readiness.buyers, href: eventSectionHref(event.id, "participants") },
              { label: "Suppliers", value: readiness.suppliers, href: eventSectionHref(event.id, "suppliers") },
              { label: "Buyer rankings", value: readiness.buyerRankings, href: eventSectionHref(event.id, "imports") },
              { label: "Supplier rankings", value: readiness.supplierRankings, href: eventSectionHref(event.id, "imports") },
            ].map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="flex flex-col gap-0.5 rounded-lg border bg-background p-3 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="text-sm text-muted-foreground">{item.label}</span>
                <span className="font-display text-2xl font-bold tabular-nums">{item.value}</span>
              </Link>
            ))}
          </div>
          {!gate.ready ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>Fix {gate.reasons.length === 1 ? "this" : "these"} before running matching</AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 pl-5">
                  {gate.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <Link className="font-semibold underline underline-offset-4" href={eventSectionHref(event.id, "imports")}>
                  Go to imports
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <section aria-labelledby="runs-title" className="flex flex-col gap-3">
        <h2 id="runs-title" className="font-display text-lg font-bold">
          Runs
        </h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No runs yet. Run matching to build the first schedule.
          </p>
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Created</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                  <TableHead className="text-right">Appointments</TableHead>
                  <TableHead className="text-right">Suppliers at target</TableHead>
                  <TableHead className="text-right">Buyers in range</TableHead>
                  <TableHead className="text-right">Mutual top {topN}</TableHead>
                  <TableHead className="text-right">Warnings</TableHead>
                  <TableHead className="pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const expanded = run.id === compareId;
                  const s = run.summary;
                  return (
                    <RunRows
                      key={run.id}
                      run={run}
                      expanded={expanded}
                      comparison={expanded ? comparison : null}
                      showAll={showAll}
                      slotTimes={slotTimes}
                      base={base}
                      created={formatTimestamp(run.createdAt, event.timezone)}
                      cells={[
                        duration(run.durationMs),
                        s ? String(s.totalAppointments) : "–",
                        s ? `${s.supplierSuccessPct}%` : "–",
                        s ? `${s.buyersInRangePct}%` : "–",
                        s ? `${s.mutualTopNPct}%` : "–",
                      ]}
                      compareHref={expanded ? base : `${base}?compare=${run.id}`}
                      canCompare={(active !== null || run.parentRunId !== null) && !run.isActive && run.status === "completed"}
                      canActivate={editable && !run.isActive && run.status === "completed"}
                      preview={previews.byRun.get(run.id) ?? null}
                      expectedActive={previews.active}
                    />
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}

function RunRows({
  run,
  expanded,
  comparison,
  showAll,
  slotTimes,
  base,
  created,
  cells,
  compareHref,
  canCompare,
  canActivate,
  preview,
  expectedActive,
}: {
  run: RunSummary;
  expanded: boolean;
  comparison: RunComparisonView | null;
  showAll: boolean;
  slotTimes: ReadonlyMap<number, string>;
  base: string;
  created: string;
  cells: string[];
  compareHref: string;
  canCompare: boolean;
  canActivate: boolean;
  preview: ActivationPreview | null;
  /** The active run the preview counts were diffed against, sent with an activation so a change since is a conflict. */
  expectedActive: ActivationPreviews["active"];
}) {
  return (
    <>
      <TableRow data-state={expanded ? "selected" : undefined}>
        <TableCell className="pl-4">
          <div className="flex flex-col gap-1">
            <span className="font-medium whitespace-nowrap tabular-nums">{created}</span>
            <span className="flex flex-wrap gap-1">
              {run.isActive ? <Badge>Active</Badge> : null}
              {run.status !== "completed" ? (
                <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{STATUS_LABEL[run.status]}</Badge>
              ) : null}
              {run.parentRunId ? <Badge variant="outline">Kept existing</Badge> : null}
            </span>
            {run.isActive && run.version > 1 ? (
              // Schedule edits and undo bump the version and restamp the stats against the roster of that moment.
              <span className="max-w-48 text-xs whitespace-normal text-muted-foreground">
                Updated at your last edit, using the roster at that time
              </span>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap">{run.createdByName ?? "Unknown"}</TableCell>
        {cells.map((value, i) => (
          <TableCell key={i} className="text-right tabular-nums">
            {value}
          </TableCell>
        ))}
        <TableCell className="text-right tabular-nums">
          {run.warnings.length ? <WarningsPopover run={run} /> : <span className="text-muted-foreground">0</span>}
        </TableCell>
        <TableCell className="pr-4">
          <div className="flex justify-end gap-2">
            {canCompare ? (
              <Button size="sm" variant="ghost" asChild>
                <Link href={compareHref} scroll={false} aria-expanded={expanded}>
                  {expanded ? <ChevronUpIcon data-icon="inline-start" /> : <ChevronDownIcon data-icon="inline-start" />}
                  {expanded ? "Hide comparison" : "Compare"}
                </Link>
              </Button>
            ) : null}
            {canActivate ? (
              <ActivateRunButton
                runId={run.id}
                disabled={false}
                preview={preview}
                expectedActiveRunId={expectedActive?.id ?? null}
                expectedVersion={expectedActive?.version ?? null}
              />
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {run.status === "failed" ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={9} className="px-4 pt-0 whitespace-normal">
            <p className="text-sm text-destructive">
              <span className="font-semibold">Why it failed:</span>{" "}
              {run.warnings.length ? run.warnings.join(" ") : "No reason was recorded. Run matching again."}
            </p>
          </TableCell>
        </TableRow>
      ) : null}
      {expanded ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={9} className="bg-muted/40 p-4 whitespace-normal">
            {comparison ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Compared with {COMPARE_LABEL[comparison.against]}.</span>
                  {comparison.options
                    .filter((option) => option !== comparison.against)
                    .map((option) => (
                      <Link
                        key={option}
                        href={`${base}?compare=${run.id}&against=${option}`}
                        scroll={false}
                        className="font-semibold underline underline-offset-4"
                      >
                        Compare with {COMPARE_LABEL[option]} instead
                      </Link>
                    ))}
                </div>
                {comparison.result.ok ? (
                  <ComparisonPanel
                    comparison={comparison.result.data}
                    against={comparison.against}
                    slotTimes={slotTimes}
                    // Show all keeps the comparison open on the same side; Show fewer drops the flag.
                    listHref={`${base}?compare=${run.id}&against=${comparison.against}`}
                    showAll={showAll}
                  />
                ) : (
                  <p className="text-sm text-destructive">{comparison.result.error.message}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">There is no other run to compare with.</p>
            )}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

/** The run's warnings (or, for a failed run, why it failed) behind its count in the Warnings column. */
function WarningsPopover({ run }: { run: RunSummary }) {
  const failed = run.status === "failed";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" className="tabular-nums">
          {run.warnings.length}
          <span className="sr-only">{failed ? ", show why it failed" : ", show warnings"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
        <PopoverHeader>
          <PopoverTitle>{failed ? "Why it failed" : run.warnings.length === 1 ? "1 warning" : `${run.warnings.length} warnings`}</PopoverTitle>
        </PopoverHeader>
        <ul className="flex max-h-72 list-disc flex-col gap-1 overflow-y-auto pl-5 text-left text-sm">
          {run.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ComparisonPanel({
  comparison,
  against,
  slotTimes,
  listHref,
  showAll,
}: {
  comparison: RunComparison;
  against: CompareTarget;
  slotTimes: ReadonlyMap<number, string>;
  listHref: string;
  showAll: boolean;
}) {
  const more = { listHref, showAll };
  const { added, removed, countChanges } = comparison;
  if (added.length === 0 && removed.length === 0) {
    return (
      <p className="text-sm">
        {against === "active"
          ? "Same appointments as the active run. Activating it changes nothing anyone sees."
          : "Same appointments as the run it kept from."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="font-semibold">
        {against === "active" ? "Activating this run adds" : "Against the run it kept from, this run adds"}{" "}
        {added.length === 1 ? "1 appointment" : `${added.length} appointments`} and removes {removed.length}, and changes the
        count of {countChanges.length} {countChanges.length === 1 ? "person" : "people"}.
      </p>
      <AppointmentTable title="Added" rows={added} slotTimes={slotTimes} more={more} />
      <AppointmentTable title="Removed" rows={removed} slotTimes={slotTimes} more={more} />
      <CompareSection title="Counts that change" total={countChanges.length} more={more}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-3">Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Before</TableHead>
              <TableHead className="pr-3 text-right">After</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {countChanges.slice(0, showAll ? undefined : COMPARE_LIMIT).map((c) => (
              <TableRow key={c.personId}>
                <TableCell className="pl-3 whitespace-normal">{c.name}</TableCell>
                <TableCell>{c.type === "buyer" ? "Buyer" : "Supplier"}</TableCell>
                <TableCell className="text-right tabular-nums">{c.before}</TableCell>
                <TableCell className="pr-3 text-right tabular-nums">{c.after}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CompareSection>
    </div>
  );
}

type CompareMore = { listHref: string; showAll: boolean };

/** One titled block of the comparison: the table, "None" when empty, and "and N more" with Show all past the limit. */
function CompareSection({
  title,
  total,
  more,
  children,
}: {
  title: string;
  total: number;
  more: CompareMore;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-semibold">
        {title} <span className="font-normal text-muted-foreground tabular-nums">({total})</span>
      </h3>
      {total === 0 ? (
        <p className="text-muted-foreground">None</p>
      ) : (
        <div className="rounded-md border bg-background">{children}</div>
      )}
      {total > COMPARE_LIMIT ? (
        <p className="text-muted-foreground">
          {more.showAll ? `All ${total} shown. ` : `and ${total - COMPARE_LIMIT} more. `}
          <Link
            href={more.showAll ? more.listHref : `${more.listHref}&all=1`}
            scroll={false}
            className="font-semibold text-foreground underline underline-offset-4"
          >
            {more.showAll ? "Show fewer" : "Show all"}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function AppointmentTable({
  title,
  rows,
  slotTimes,
  more,
}: {
  title: string;
  rows: AppointmentView[];
  slotTimes: ReadonlyMap<number, string>;
  more: CompareMore;
}) {
  return (
    <CompareSection title={title} total={rows.length} more={more}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-16 pl-3">Slot</TableHead>
            <TableHead className="w-24">Time</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead className="pr-3">Buyer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.slice(0, more.showAll ? undefined : COMPARE_LIMIT).map((a) => (
            <TableRow key={a.id}>
              <TableCell className="pl-3 tabular-nums">{a.slot}</TableCell>
              <TableCell className="tabular-nums">{slotTimes.get(a.slot) ?? "–"}</TableCell>
              <TableCell className="whitespace-normal">{a.supplierName}</TableCell>
              <TableCell className="pr-3 whitespace-normal">{a.buyerName}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CompareSection>
  );
}
