import {
  ArrowLeftIcon,
  CircleOffIcon,
  CopyIcon,
  FileWarningIcon,
  InfoIcon,
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
import { isRankingKind, type EntityType, type ImportValidationReport } from "@/lib/schemas/import";
import { formatTimestamp } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import { getImport, listImports } from "@/server/imports/queries";
import { fullNameFor, listParticipants, listSuppliers } from "@/server/roster/queries";
import { lockReason } from "../../_roster/lock-reason";
import { eventSectionHref } from "../../event-sections";
import { ImportStateBadge, KIND_LABELS, plural } from "../import-labels";
import { ApplyPanel } from "./apply-panel";
import { NameMappingTable, type EntityOption } from "./name-mapping-table";
import { ReportSection } from "./report-section";

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
      hint: "These people chose nobody in this file, so they get no rankings from it.",
      icon: <CircleOffIcon />,
      items: report.rowsWithZeroRankings.map((r) => `Row ${r.row}: ${r.name}`),
    },
    {
      title: "Ranked by nobody",
      hint: "Nobody in this file chose them. The engine can still place them, but only on unranked pairs.",
      icon: <InfoIcon />,
      items: report.rankedByNobody.map((e) => e.name),
    },
    {
      title: "Ranked nobody",
      hint: "Active people on the roster who aren't in this file or chose nobody.",
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

export default async function ImportDetailPage({ params }: { params: Promise<{ id: string; importId: string }> }) {
  await requireSession();
  const { id, importId } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const detail = /^[0-9a-f-]{36}$/i.test(importId) ? await getImport(importId) : null;
  if (!detail || detail.eventId !== event.id) notFound();

  const report = detail.report;
  const ranking = isRankingKind(detail.kind);
  const locked = lockReason(event, "map names or apply files");
  const needsMapping = detail.state !== "applied" && (report?.unknownNames.length ?? 0) > 0;

  const [history, participants, suppliers] = await Promise.all([
    listImports(event.id),
    needsMapping ? listParticipants(event.id, { includeWithdrawn: true }) : Promise.resolve([]),
    needsMapping ? listSuppliers(event.id, { includeWithdrawn: true }) : Promise.resolve([]),
  ]);
  const newerExists = history.some((item) => item.kind === detail.kind && item.createdAt > detail.createdAt);
  const withdrawnHint = (status: string) => (status === "withdrawn" ? "withdrawn" : undefined);
  const entities: Record<EntityType, EntityOption[]> = {
    buyer: participants.map((p) => ({
      value: p.id,
      label: p.organization ? `${fullNameFor(p)} (${p.organization})` : fullNameFor(p),
      hint: withdrawnHint(p.status),
    })),
    supplier: suppliers.map((s) => ({ value: s.id, label: s.name, hint: withdrawnHint(s.status) })),
  };
  const importsHref = eventSectionHref(event.id, "imports");
  const uploaded = `${formatTimestamp(detail.createdAt, event.timezone)}${detail.createdByName ? ` by ${detail.createdByName}` : ""}`;

  return (
    <>
      <Button variant="ghost" size="sm" className="self-start" asChild>
        <Link href={importsHref}>
          <ArrowLeftIcon data-icon="inline-start" />
          Imports
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
        kind={detail.kind}
        state={detail.state}
        rows={report?.counts.rows ?? 0}
        rankings={report?.counts.rankings ?? 0}
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

      {needsMapping && report ? (
        <section className="flex flex-col gap-3" aria-labelledby="mapping-heading">
          <h2 id="mapping-heading" className="font-display text-lg font-bold">
            Map unknown names <span className="tabular-nums text-muted-foreground">({plural(report.unknownNames.length, "name")})</span>
          </h2>
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
