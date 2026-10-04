import { AlertTriangleIcon, ChevronDownIcon, ChevronUpIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTimestamp } from "@/lib/time";
import { isEventEditable } from "@/server/events/editable";
import { requireSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import {
  activationPreviews,
  compareRunForPage,
  listRuns,
  type ActivationPreview,
  type CompareTarget,
  type RunComparisonView,
  type RunSummary,
} from "@/server/matching/queries";
import { getMatchingGate } from "@/server/matching/readiness";
import type { RunComparison } from "@/server/matching/runs";
import { eventSectionHref } from "../event-sections";
import { ActivateRunButton, RunMatchingButtons } from "./run-actions";

const STATUS_LABEL: Record<RunSummary["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

/** Rows shown per list in a comparison before "and N more". */
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
  searchParams: Promise<{ compare?: string | string[]; against?: string | string[] }>;
}) {
  await requireSession();
  const [{ id }, { compare, against }] = await Promise.all([params, searchParams]);
  const event = await getEvent(id);
  if (!event) notFound();
  const [gate, runs, previews] = await Promise.all([getMatchingGate(event.id), listRuns(event.id), activationPreviews(event.id)]);
  const readiness = gate.counts;
  const active = runs.find((r) => r.isActive) ?? null;
  const compareId =
    typeof compare === "string" && runs.some((r) => r.id === compare && !r.isActive && r.status === "completed") ? compare : null;
  const target: CompareTarget | undefined = against === "active" || against === "parent" ? against : undefined;
  const comparison = compareId ? await compareRunForPage(event.id, compareId, target) : null;
  const editable = isEventEditable(event);
  const topN = event.settings.mutualTopN;
  const base = eventSectionHref(event.id, "matching");

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
          <CardTitle className="font-display text-lg font-bold">Ready to match</CardTitle>
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
              <AlertTitle>Not ready to match</AlertTitle>
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
                      preview={previews.get(run.id) ?? null}
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
  base,
  created,
  cells,
  compareHref,
  canCompare,
  canActivate,
  preview,
}: {
  run: RunSummary;
  expanded: boolean;
  comparison: RunComparisonView | null;
  base: string;
  created: string;
  cells: string[];
  compareHref: string;
  canCompare: boolean;
  canActivate: boolean;
  preview: ActivationPreview | null;
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
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap">{run.createdByName ?? "Unknown"}</TableCell>
        {cells.map((value, i) => (
          <TableCell key={i} className="text-right tabular-nums">
            {value}
          </TableCell>
        ))}
        <TableCell className="text-right tabular-nums">
          {run.warningCount ? <Badge variant="outline">{run.warningCount}</Badge> : <span className="text-muted-foreground">0</span>}
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
            {canActivate ? <ActivateRunButton runId={run.id} disabled={false} preview={preview} /> : null}
          </div>
        </TableCell>
      </TableRow>
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
                  <ComparisonPanel comparison={comparison.result.data} against={comparison.against} />
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

function ComparisonPanel({ comparison, against }: { comparison: RunComparison; against: CompareTarget }) {
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
  const more = (n: number) => (n > COMPARE_LIMIT ? <li className="text-muted-foreground">and {n - COMPARE_LIMIT} more</li> : null);
  return (
    <div className="flex max-w-5xl flex-col gap-4 text-sm">
      <p className="font-semibold">
        {against === "active" ? "Activating this run adds" : "Against the run it kept from, this run adds"} {added.length} and
        removes {removed.length} appointments, and changes the count of {countChanges.length}{" "}
        {countChanges.length === 1 ? "person" : "people"}.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <h3 className="font-semibold">Added</h3>
          <ul className="flex flex-col gap-1">
            {added.slice(0, COMPARE_LIMIT).map((a) => (
              <li key={a.id}>
                <span className="tabular-nums text-muted-foreground">Slot {a.slot}</span> {a.supplierName} with {a.buyerName}
              </li>
            ))}
            {added.length === 0 ? <li className="text-muted-foreground">None</li> : null}
            {more(added.length)}
          </ul>
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="font-semibold">Removed</h3>
          <ul className="flex flex-col gap-1">
            {removed.slice(0, COMPARE_LIMIT).map((a) => (
              <li key={a.id}>
                <span className="tabular-nums text-muted-foreground">Slot {a.slot}</span> {a.supplierName} with {a.buyerName}
              </li>
            ))}
            {removed.length === 0 ? <li className="text-muted-foreground">None</li> : null}
            {more(removed.length)}
          </ul>
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="font-semibold">Counts that change</h3>
          <ul className="flex flex-col gap-1">
            {countChanges.slice(0, COMPARE_LIMIT).map((c) => (
              <li key={c.personId}>
                {c.name} <span className="text-muted-foreground">({c.type})</span>{" "}
                <span className="tabular-nums">
                  {c.before} → {c.after}
                </span>
              </li>
            ))}
            {countChanges.length === 0 ? <li className="text-muted-foreground">None</li> : null}
            {more(countChanges.length)}
          </ul>
        </div>
      </div>
    </div>
  );
}
