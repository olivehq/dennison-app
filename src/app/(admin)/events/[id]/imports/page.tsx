import { ArrowRightIcon, CheckCircle2Icon, CircleDashedIcon, CircleAlertIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { isRankingKind, type ImportKind } from "@/lib/schemas/import";
import { formatTimestamp } from "@/lib/time";
import { getEvent } from "@/server/events/queries";
import {
  getImportStatusByKind,
  importKinds,
  listImports,
  readinessForMatching,
  type ImportSummary,
  type MatchingReadiness,
} from "@/server/imports/queries";
import { lockReason } from "../_roster/lock-reason";
import { eventSectionHref } from "../event-sections";
import { ImportHistoryTable, type HistoryRow } from "./import-history-table";
import { ImportStateBadge, importHref, KIND_LABELS, plural } from "./import-labels";
import { UploadCard, type LatestImport } from "./upload-card";

function facts(summary: ImportSummary): string[] {
  const counts = summary.counts;
  if (!counts || summary.state === "failed") return [];
  const out = [plural(counts.rows, "row")];
  if (isRankingKind(summary.kind)) out.push(plural(counts.rankings, "ranking"));
  if (counts.unknownNames > 0) out.push(plural(counts.unknownNames, "unknown name"));
  if (counts.errors > 0) out.push(plural(counts.errors, "error"));
  if (counts.warnings > 0) out.push(plural(counts.warnings, "warning"));
  return out;
}

function ReadinessPanel({ eventId, readiness }: { eventId: string; readiness: MatchingReadiness }) {
  const pendingByKind = new Map(readiness.pending.map((entry) => [entry.kind, entry]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{readiness.ready ? "Ready for matching" : "Before matching"}</CardTitle>
        <CardDescription>
          {readiness.ready
            ? "All five files are applied. You can run matching now and re-run it after any change."
            : "Matching needs all five files applied. Upload what's missing and apply each one."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {importKinds.map((kind: ImportKind) => {
            const pending = pendingByKind.get(kind);
            const applied = readiness.applied.includes(kind);
            return (
              <li key={kind} className="flex items-center gap-2 text-sm">
                {applied ? (
                  <CheckCircle2Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                ) : pending ? (
                  <CircleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
                ) : (
                  <CircleDashedIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="min-w-0">{KIND_LABELS[kind]}</span>
                {applied ? (
                  <span className="text-muted-foreground">applied</span>
                ) : pending ? (
                  <Link href={importHref(eventId, pending.importId)} className="flex items-center gap-1.5">
                    <ImportStateBadge state={pending.state} />
                    <span className="sr-only">Review</span>
                  </Link>
                ) : (
                  <span className="text-muted-foreground">not uploaded</span>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
      {readiness.ready ? (
        <CardFooter>
          <Button asChild>
            <Link href={eventSectionHref(eventId, "matching")}>
              Go to matching
              <ArrowRightIcon data-icon="inline-end" />
            </Link>
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

export default async function ImportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();

  const [byKind, readiness, history] = await Promise.all([
    getImportStatusByKind(event.id),
    readinessForMatching(event.id),
    listImports(event.id),
  ]);
  const locked = lockReason(event, "upload or apply files");

  const latest = (kind: ImportKind): LatestImport | null => {
    const summary = byKind[kind];
    if (!summary) return null;
    return {
      id: summary.id,
      fileName: summary.fileName,
      state: summary.state,
      facts: facts(summary),
      uploadedLabel: `${formatTimestamp(summary.createdAt, event.timezone)}${summary.createdByName ? ` by ${summary.createdByName}` : ""}`,
    };
  };

  const rows: HistoryRow[] = history.map((item) => ({
    id: item.id,
    fileName: item.fileName,
    kind: item.kind,
    state: item.state,
    rows: item.rowCount,
    uploadedBy: item.createdByName ?? "Unknown",
    uploadedAt: item.createdAt.getTime(),
    uploadedLabel: formatTimestamp(item.createdAt, event.timezone),
  }));

  return (
    <>
      <PageHeader
        title="Imports"
        description="Upload the roster files and the three eShow ranking files. Each file is checked first; nothing changes until you apply it."
      />
      {locked ? (
        <Alert>
          <LockIcon />
          <AlertTitle>Read-only</AlertTitle>
          <AlertDescription>{locked}</AlertDescription>
        </Alert>
      ) : null}
      <ReadinessPanel eventId={event.id} readiness={readiness} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {importKinds.map((kind) => (
          <UploadCard key={kind} eventId={event.id} kind={kind} latest={latest(kind)} lockedReason={locked} />
        ))}
      </div>
      <section className="flex flex-col gap-3" aria-labelledby="import-history">
        <h2 id="import-history" className="font-display text-lg font-bold">
          History
        </h2>
        <ImportHistoryTable eventId={event.id} rows={rows} lockedReason={locked} />
      </section>
    </>
  );
}
