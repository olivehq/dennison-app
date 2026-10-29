import {
  ArrowLeftIcon,
  CircleOffIcon,
  CopyIcon,
  FileWarningIcon,
  InfoIcon,
  LinkIcon,
  MailXIcon,
  OctagonXIcon,
  TriangleAlertIcon,
  UserRoundSearchIcon,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/db/client";
import { isRankingKind, type EntityType, type ImportValidationReport } from "@/lib/schemas/import";
import { formatTimestamp } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import { reportIsStale } from "@/server/imports/imports";
import { countRankingsToReplace, getImport, listImports, listSavedNameMappings } from "@/server/imports/queries";
import { fullNameFor, listParticipants, listSuppliers } from "@/server/roster/queries";
import { lockReason } from "../../_roster/lock-reason";
import { eventSectionHref } from "../../event-sections";
import { ImportStateBadge, KIND_LABELS, plural } from "../import-labels";
import { importsHistoryHref } from "../imports-tabs";
import { SavedNameMappings } from "../saved-name-mappings";
import { ApplyPanel } from "./apply-panel";
import { NameMappingTable, type EntityOption } from "./name-mapping-table";
import { ReportSection } from "./report-section";
import { StaleReportAlert } from "./stale-report-alert";

const FORMAT_LABELS = {
  template: "Olive template",
  list: "eShow list (CHOICE #n columns)",
  matrix: "2025 matrix",
} as const;

function rowPrefix(row: number | null): string {
  return row === null ? "" : `Row ${row}: `;
}

function rowsText(rows: number[]): string {
  return rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.join(", ")}`;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-bold tabular-nums">{value}</dd>
    </div>
  );
}

function ReportSections({ report, ranking }: { report: ImportValidationReport; ranking: boolean }) {
  const duplicates = [
    ...report.duplicateEmails.map((d) => `${d.value} on ${rowsText(d.rows)}`),
    ...report.duplicateNames.map((d) => `${d.value} on ${rowsText(d.rows)}`),
  ];
  const sections = [
    {
      title: "Errors",
      hint: "These block the import. Fix them in the file and upload it again.",
      icon: <OctagonXIcon />,
      tone: "destructive" as const,
      items: report.errors.map((e) => `${rowPrefix(e.row)}${e.message}`),
      defaultOpen: true,
    },
    {
      title: "Warnings",
      hint: "These don't block the import. Check they're expected.",
      icon: <TriangleAlertIcon />,
      items: report.warnings.map((w) => `${rowPrefix(w.row)}${w.message}`),
      defaultOpen: true,
    },
    {
      title: "Unknown names",
      hint: "Names that match nobody on the roster. Map them in the table below.",
      icon: <UserRoundSearchIcon />,
      items: report.unknownNames.map((n) => `“${n.raw}” on ${rowsText(n.rows)}`),
    },
    {
      title: "Read through a saved name",
      hint: "No one on the roster has these names, so a saved mapping decided who they are. If one is wrong, remove it below and the file is checked again.",
      icon: <LinkIcon />,
      items: (report.aliasedNames ?? []).map(
        (n) => `“${n.raw}” as ${n.name} on ${rowsText(n.rows)}, saved ${n.scope === "event" ? "for this event" : "in another event"}`,
      ),
    },
    {
      title: "Duplicates",
      hint: "The same email or name on more than one row. Keep one row each.",
      icon: <CopyIcon />,
      tone: "destructive" as const,
      items: duplicates,
    },
    {
      title: "Missing emails",
      hint: "Every participant needs an email. Fill these rows in.",
      icon: <MailXIcon />,
      tone: "destructive" as const,
      items: report.missingEmails.map((row) => `Row ${row}`),
    },
    {
      title: "Rows with zero rankings",
      hint: "These people chose nobody in this file. Applying it clears their rankings of this kind.",
      icon: <CircleOffIcon />,
      items: report.rowsWithZeroRankings.map((r) => `Row ${r.row}: ${r.name}`),
    },
    {
      title: "Ranked by nobody",
      hint: "Nobody in this file chose them. Choices from earlier files still count, and the engine can place them on unranked pairs.",
      icon: <InfoIcon />,
      items: report.rankedByNobody.map((e) => e.name),
    },
    {
      title: "Ranked nobody",
      hint: "Active people on the roster who aren't in this file or chose nobody. People not in this file keep their current rankings.",
      icon: <FileWarningIcon />,
      items: report.rankedNobody.map((e) => e.name),
    },
  ].filter((section) => section.items.length > 0 && (ranking || !section.title.startsWith("Ranked")));

  if (sections.length === 0) {
    return (
      <Alert>
        <InfoIcon />
        <AlertTitle>No problems found</AlertTitle>
        <AlertDescription>Every row was read and every name matched the roster.</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => (
        <ReportSection key={section.title} count={section.items.length} {...section} />
      ))}
    </div>
  );
}

export default async function ImportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; importId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const [{ id, importId }, query] = await Promise.all([params, searchParams]);
  const event = await getEvent(id);
  if (!event) notFound();
  const detail = /^[0-9a-f-]{36}$/i.test(importId) ? await getImport(importId) : null;
  if (!detail || detail.eventId !== event.id) notFound();

  const report = detail.report;
  const ranking = isRankingKind(detail.kind);
  const locked = lockReason(event, "map names or apply files");
  const needsMapping =
    detail.state !== "applied" && detail.state !== "ignored" && (report?.unknownNames.length ?? 0) > 0;
  // What an apply replaces, for the confirmation. Reports from before replace-per-ranker have no ranker list.
  const rankersKnown = report !== null && report.rankersInFile.length === report.counts.rankers;

  const aliased = report?.aliasedNames ?? [];
  const [history, participants, suppliers, replacing, savedMappings, stale] = await Promise.all([
    listImports(event.id),
    needsMapping ? listParticipants(event.id, { includeWithdrawn: true }) : Promise.resolve([]),
    needsMapping ? listSuppliers(event.id, { includeWithdrawn: true }) : Promise.resolve([]),
    detail.state === "ready" && rankersKnown && isRankingKind(detail.kind)
      ? countRankingsToReplace(event.id, detail.kind, report.rankersInFile)
      : Promise.resolve(null),
    aliased.length > 0 ? listSavedNameMappings(event.id) : Promise.resolve([]),
    report && detail.status === "validated" ? reportIsStale(getDb(), detail.id) : Promise.resolve(false),
  ]);
  // The saved mappings this file was read through, so a wrong one can be removed here.
  // Keyed the way the resolver reads them: this event's aliases match the exact
  // text, cross-year ones ignore case (resolve.ts buildIndex).
  const mappingKey = (scope: string, entityType: string, raw: string) =>
    `${scope}:${entityType}:${scope === "event" ? raw.trim() : raw.trim().toLowerCase()}`;
  const aliasedKeys = new Set(aliased.map((n) => mappingKey(n.scope, n.entityType, n.raw)));
  const usedMappings = savedMappings.filter((m) => aliasedKeys.has(mappingKey(m.scope, m.entityType, m.rawText)));
  // Names nobody on the roster has (not shared ones): often a roster file that isn't loaded yet.
  const missingTypes = new Set(
    needsMapping && report ? report.unknownNames.filter((n) => !n.ambiguous).map((n) => n.entityType) : [],
  );
  const newerExists = history.some(
    (item) => item.kind === detail.kind && item.state !== "ignored" && item.createdAt > detail.createdAt,
  );
  const withdrawnHint = (status: string) => (status === "withdrawn" ? "withdrawn" : undefined);
  const entities: Record<EntityType, EntityOption[]> = {
    // Name, organization, title, and email, so two people with one name can be told apart.
    buyer: participants.map((p) => ({
      value: p.id,
      label: `${fullNameFor(p)} (${[p.organization, p.title, p.email].filter(Boolean).join(", ")})`,
      hint: withdrawnHint(p.status),
    })),
    supplier: suppliers.map((s) => ({ value: s.id, label: s.name, hint: withdrawnHint(s.status) })),
  };
  const importsHref = eventSectionHref(event.id, "imports");
  // Opened from the History tab: go back there; otherwise back to Upload.
  const fromHistory = query.from === "history";
  const uploaded = `${formatTimestamp(detail.createdAt, event.timezone)}${detail.createdByName ? ` by ${detail.createdByName}` : ""}`;

  return (
    <>
      <Button variant="ghost" size="sm" className="self-start" asChild>
        <Link href={fromHistory ? importsHistoryHref(event.id) : importsHref}>
          <ArrowLeftIcon data-icon="inline-start" />
          {fromHistory ? "Import history" : "Imports"}
        </Link>
      </Button>
      <PageHeader
        title={<span className="break-all">{detail.fileName}</span>}
        status={<ImportStateBadge state={detail.state} />}
        description={`${KIND_LABELS[detail.kind]}. Uploaded ${uploaded}.`}
      />

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
          <CardDescription>
            {report?.format ? `Read as ${FORMAT_LABELS[report.format]}.` : "The file couldn't be read, so no format was detected."}
          </CardDescription>
        </CardHeader>
        {report ? (
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Rows" value={report.counts.rows} />
              {ranking ? <Stat label="Rankers" value={report.counts.rankers} /> : null}
              {ranking ? <Stat label="Rankings" value={report.counts.rankings} /> : null}
              {ranking ? <Stat label="Unknown names" value={report.counts.unknownNames} /> : null}
              <Stat label="Errors" value={report.counts.errors} />
              <Stat label="Warnings" value={report.counts.warnings} />
            </dl>
          </CardContent>
        ) : null}
      </Card>

      <ApplyPanel
        importId={detail.id}
        fileName={detail.fileName}
        kind={detail.kind}
        state={detail.state}
        rows={report?.counts.rows ?? 0}
        rankings={report?.counts.rankings ?? 0}
        rankers={report?.counts.rankers ?? 0}
        rosterChanges={report?.rosterChanges ?? null}
        replacing={replacing}
        biztechFromFile={event.settings.biztechOptInRule === "from_biztech_file"}
        eventIsDraft={event.status === "draft"}
        newerExists={newerExists}
        lockedReason={locked}
        appliedLabel={detail.appliedAt ? formatTimestamp(detail.appliedAt, event.timezone) : null}
        importsHref={importsHref}
        matchingHref={eventSectionHref(event.id, "matching")}
      />

      <section className="flex flex-col gap-3" aria-labelledby="report-heading">
        <h2 id="report-heading" className="font-display text-lg font-bold">
          Validation report
        </h2>
        {stale ? <StaleReportAlert importId={detail.id} lockedReason={locked} /> : null}
        {report ? (
          <ReportSections report={report} ranking={ranking} />
        ) : (
          <Alert variant="destructive">
            <OctagonXIcon />
            <AlertTitle>No report</AlertTitle>
            <AlertDescription>This import has no readable report. Upload the file again.</AlertDescription>
          </Alert>
        )}
      </section>

      {usedMappings.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="saved-names-heading">
          <h2 id="saved-names-heading" className="font-display text-lg font-bold">
            Saved names this file used
          </h2>
          <SavedNameMappings eventId={event.id} mappings={usedMappings} lockedReason={locked} />
        </section>
      ) : null}

      {needsMapping && report ? (
        <section className="flex flex-col gap-3" aria-labelledby="mapping-heading">
          <h2 id="mapping-heading" className="font-display text-lg font-bold">
            Map unknown names <span className="tabular-nums text-muted-foreground">({plural(report.unknownNames.length, "name")})</span>
          </h2>
          {[...missingTypes].map((type) => (
            <Alert key={type}>
              <InfoIcon />
              <AlertTitle>Load the {type === "supplier" ? "suppliers" : "participants"} file first?</AlertTitle>
              <AlertDescription>
                {type === "supplier"
                  ? "These names aren't on the supplier list yet. If they're in a suppliers file you haven't loaded, upload and apply it first; this file is checked again automatically."
                  : "These names aren't on the participant list yet. If they're in a participants file you haven't loaded, upload and apply it first; this file is checked again automatically."}
              </AlertDescription>
            </Alert>
          ))}
          <NameMappingTable
            eventId={event.id}
            importId={detail.id}
            names={report.unknownNames}
            entities={entities}
            lockedReason={locked}
          />
        </section>
      ) : null}
    </>
  );
}
