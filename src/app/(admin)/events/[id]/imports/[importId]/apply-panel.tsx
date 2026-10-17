"use client";

import * as React from "react";
import { CheckCircle2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ImportKind, ImportState } from "@/lib/schemas/import";
import { applyImportAction } from "@/server/imports/actions";
import type { ApplySummary } from "@/server/imports/imports";
import { setImportIgnored } from "../ignore-toggle";
import { KIND_LABELS, plural } from "../import-labels";

type ApplyPanelProps = {
  importId: string;
  fileName: string;
  kind: ImportKind;
  state: ImportState;
  rows: number;
  rankings: number;
  /** Ranking kinds: the people with a row in the file. */
  rankers: number;
  /** Ranking kinds: their current rankings an apply replaces, or null when the report can't tell. */
  replacing: number | null;
  /** The event opts people in from the biztech file (D1). */
  biztechFromFile: boolean;
  eventIsDraft: boolean;
  /** A newer upload of the same kind exists. */
  newerExists: boolean;
  lockedReason: string | null;
  appliedLabel: string | null;
  importsHref: string;
  matchingHref: string;
};

function rankerNoun(kind: ImportKind): string {
  return kind === "supplier_rankings" ? "supplier" : "participant";
}

function rankingChanges({ kind, rankers, rankings, replacing }: ApplyPanelProps): string[] {
  const lines = [`This file changes the rankings of ${plural(rankers, rankerNoun(kind))}.`];
  if (replacing === null) {
    lines.push(`Their rankings from earlier files of this kind are replaced with ${plural(rankings, "ranking")} from this file.`);
  } else if (replacing > 0) {
    lines.push(
      `Their ${plural(replacing, "current ranking")} from earlier files of this kind ${replacing === 1 ? "is" : "are"} replaced with ${plural(rankings, "ranking")} from this file.`,
    );
  } else {
    lines.push(`Adds ${plural(rankings, "ranking")} for them. They have none from earlier files of this kind.`);
  }
  lines.push("Everyone else keeps their current rankings.");
  return lines;
}

function whatChanges(props: ApplyPanelProps): string[] {
  const { kind, rows, biztechFromFile, eventIsDraft } = props;
  const lines: string[] = [];
  switch (kind) {
    case "participants":
      lines.push(
        `Adds or updates ${plural(rows, "participant")}, matched by email. Withdrawn people stay withdrawn and nobody is deleted.`,
        "A blank biztech opt-in cell keeps the current value.",
      );
      break;
    case "suppliers":
      lines.push(
        `Adds or updates ${plural(rows, "supplier")}, matched by name. Withdrawn suppliers stay withdrawn.`,
        "If a contact email changed, that contact's schedule link is revoked.",
      );
      break;
    default:
      lines.push(...rankingChanges(props));
      if (kind === "buyer_biztech_rankings") {
        lines.push(
          biztechFromFile
            ? "Biztech opt-in changes only for the participants in this file. Those with at least one choice are opted in, the rest are opted out."
            : "Opt-in flags don't change, because this event opts everyone in to biztech.",
        );
      }
  }
  if (eventIsDraft) lines.push("Moves the event from Draft to Imported.");
  return lines;
}

function blockedReason(props: ApplyPanelProps): string | null {
  if (props.lockedReason) return props.lockedReason;
  switch (props.state) {
    case "failed":
      return "This file couldn't be read. Fix it and upload it again on the Imports page.";
    case "needs_mapping":
      return "Map every unknown name below before you apply this file.";
    case "needs_fixes":
      return "Fix the errors listed below in the file, then upload it again.";
    case "applied":
      return props.appliedLabel ? `Applied ${props.appliedLabel}.` : "This file is applied.";
    case "ignored":
      return "This file is ignored, so it doesn't block matching. Stop ignoring it to check it again and apply it.";
    case "ready":
      return null;
  }
}

function summaryLines(summary: ApplySummary): string[] {
  const lines: string[] = [];
  if (summary.kind === "participants" || summary.kind === "suppliers") {
    lines.push(`${summary.created} added, ${summary.updated} updated.`);
  } else {
    lines.push(
      `${plural(summary.rankingsWritten, "ranking")} written for ${plural(summary.rankers, rankerNoun(summary.kind))}, replacing ${plural(summary.rankingsDeleted, "earlier ranking")}. Everyone else kept their rankings.`,
    );
    if (summary.kind === "buyer_biztech_rankings") {
      lines.push(`${summary.optedIn} opted in to biztech, ${summary.optedOut} opted out.`);
    }
    if (summary.aliasesSaved > 0) {
      lines.push(`${plural(summary.aliasesSaved, "spelling")} saved as automatic aliases for next time.`);
    }
  }
  if (summary.eventAdvanced) lines.push("The event moved from Draft to Imported.");
  return lines;
}

export function ApplyPanel(props: ApplyPanelProps) {
  const router = useRouter();
  const [summary, setSummary] = React.useState<ApplySummary | null>(null);
  const [ignoring, startIgnoring] = React.useTransition();
  const blocked = blockedReason(props);
  const ignored = props.state === "ignored";

  const toggleIgnored = () => {
    startIgnoring(async () => {
      await setImportIgnored(props.importId, props.fileName, !ignored);
    });
  };

  const apply = async () => {
    const result = await applyImportAction(props.importId);
    if (!result.ok) {
      toast.error(result.error.message);
      router.refresh();
      return;
    }
    setSummary(result.data.summary);
    toast.success(`${KIND_LABELS[props.kind]} applied.`);
  };

  if (summary) {
    return (
      <Alert>
        <CheckCircle2Icon />
        <AlertTitle>Applied</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <ul className="flex flex-col gap-0.5">
            {summaryLines(summary).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <span className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={props.importsHref}>Back to imports</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={props.matchingHref}>Go to matching</Link>
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ConfirmDialog
        title={`Apply ${KIND_LABELS[props.kind].toLowerCase()}?`}
        description={
          <span className="flex flex-col gap-1">
            {whatChanges(props).map((line) => (
              <span key={line}>{line}</span>
            ))}
            {props.newerExists ? (
              <span className="font-medium text-foreground">A newer file of this kind was uploaded after this one.</span>
            ) : null}
          </span>
        }
        confirmLabel="Apply import"
        onConfirm={apply}
        trigger={<Button disabled={blocked !== null}>Apply import</Button>}
      />
      {props.state !== "applied" ? (
        <Button variant="outline" onClick={toggleIgnored} disabled={props.lockedReason !== null || ignoring}>
          {ignoring ? <Spinner data-icon="inline-start" /> : null}
          {ignored ? "Stop ignoring" : "Ignore file"}
        </Button>
      ) : null}
      {blocked ? <p className="w-full text-sm text-muted-foreground">{blocked}</p> : null}
      {props.state !== "applied" && !ignored && !props.lockedReason ? (
        <p className="w-full text-sm text-muted-foreground">
          Not using this file? Ignore it to keep it in history without blocking matching.
        </p>
      ) : null}
    </div>
  );
}
