import { ArrowRightIcon, CheckCircle2Icon, LockIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "cn";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ImportKind } from "@/lib/schemas/import";
import { formatTimestamp } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import { getImportStatusByKind, listImports, type ImportSummary } from "@/server/imports/queries";
import { getMatchingGate } from "@/server/matching/readiness";
import { lockReason } from "../_roster/lock-reason";
import { eventSectionHref } from "../event-sections";
import { importHref, KIND_LABELS } from "./import-labels";
import { ImportsTabs } from "./imports-tabs";
import { readinessPanelModel, type ReadinessPanelModel } from "./readiness-panel";
import { UploadCard } from "./upload-card";
import { uploadCardState } from "./upload-card-state";

const STEPS: { title: string; description: string; kinds: ImportKind[] }[] = [
  {
    title: "Step 1. Roster files",
    description: "Who is coming. Apply these first so the rankings can find everyone.",
    kinds: ["participants", "suppliers"],
  },
  {
    title: "Step 2. Ranking files",
    description: "Who wants to meet whom, from the three eShow exports.",
    kinds: ["buyer_biztech_rankings", "buyer_hotel_rankings", "supplier_rankings"],
  },
];

function ReadinessLine({ eventId, panel }: { eventId: string; panel: ReadinessPanelModel }) {
  const Icon = panel.ready ? CheckCircle2Icon : TriangleAlertIcon;
  return (
    <section
      aria-label="Matching readiness"
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-start",
        panel.ready ? "border-hotel/30 bg-hotel-tint/55" : "border-warning/50 bg-warning/15",
      )}
    >
      <div className="flex min-w-0 flex-1 gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", panel.ready ? "text-hotel-ink" : "text-warning-foreground")} aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium">{panel.title}</p>
          {panel.ready ? (
            <p className="text-muted-foreground">You can run matching now and re-run it after any change.</p>
          ) : panel.reasons.length === 1 ? (
            <p>{panel.reasons[0]}</p>
          ) : (
            <ul className="flex list-disc flex-col gap-0.5 pl-4">
              {panel.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {panel.ready ? (
        <Button variant="outline" size="sm" className="self-start" asChild>
          <Link href={eventSectionHref(eventId, "matching")}>
            Go to matching
            <ArrowRightIcon data-icon="inline-end" />
          </Link>
        </Button>
      ) : panel.review ? (
        <Button variant="outline" size="sm" className="self-start" asChild>
          <Link href={importHref(eventId, panel.review.importId)}>
            Review the {KIND_LABELS[panel.review.kind].toLowerCase()} file
            <ArrowRightIcon data-icon="inline-end" />
          </Link>
        </Button>
      ) : null}
    </section>
  );
}

export default async function ImportsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();

  const [byKind, gate, history] = await Promise.all([
    getImportStatusByKind(event.id),
    getMatchingGate(event.id),
    listImports(event.id),
  ]);
  const locked = lockReason(event, "upload or apply files");

  const uploadedLabel = (summary: ImportSummary) =>
    `${formatTimestamp(summary.createdAt, event.timezone)}${summary.createdByName ? ` by ${summary.createdByName}` : ""}`;

  const card = (kind: ImportKind) => {
    const latest = byKind[kind];
    // Only when every file of the kind is ignored; history is newest first.
    const ignored = latest ? null : (history.find((item) => item.kind === kind && item.state === "ignored") ?? null);
    const shown = latest ?? ignored;
    return (
      <UploadCard
        key={kind}
        eventId={event.id}
        kind={kind}
        latest={shown ? { id: shown.id, fileName: shown.fileName, uploadedLabel: uploadedLabel(shown) } : null}
        state={uploadCardState(kind, latest, ignored)}
        lockedReason={locked}
      />
    );
  };

  return (
    <>
      <PageHeader
        title="Imports"
        description="Each file is checked first. Nothing changes until you apply it."
      />
      <div className="flex flex-col gap-5">
        <ImportsTabs eventId={event.id} active="upload" historyCount={history.length} />
        {locked ? (
          <Alert>
            <LockIcon />
            <AlertTitle>Read-only</AlertTitle>
            <AlertDescription>{locked}</AlertDescription>
          </Alert>
        ) : null}
        <ReadinessLine eventId={event.id} panel={readinessPanelModel(gate, byKind)} />
        {STEPS.map((step) => (
          <section key={step.title} aria-labelledby={`step-${step.kinds[0]}`} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 id={`step-${step.kinds[0]}`} className="font-display text-base font-bold">
                {step.title}
              </h2>
              <p className="text-sm text-muted-foreground">{step.description}</p>
            </div>
            <div className={cn("grid gap-3 sm:grid-cols-2", step.kinds.length === 3 && "lg:grid-cols-3")}>
              {step.kinds.map(card)}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
