"use client";

import * as React from "react";
import { CheckCircle2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ImportKind, ImportState } from "@/lib/schemas/import";
import { applyImportAction } from "@/server/imports/actions";
import type { ApplySummary } from "@/server/imports/imports";
import { KIND_LABELS, plural } from "../import-labels";

type ApplyPanelProps = {
  importId: string;
  kind: ImportKind;
  state: ImportState;
  rows: number;
  rankings: number;
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

function whatChanges({ kind, rows, rankings, biztechFromFile, eventIsDraft }: ApplyPanelProps): string[] {
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
      lines.push(
        `Replaces the ${KIND_LABELS[kind].toLowerCase()} from earlier files with this file's ${plural(rankings, "ranking")}.`,
      );
      if (kind === "buyer_biztech_rankings") {
        lines.push(
          biztechFromFile
            ? "Updates biztech opt-in: participants with at least one choice are opted in, every other active participant is opted out."
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
    case "ready":
      return null;
  }
}

function summaryLines(summary: ApplySummary): string[] {
  const lines: string[] = [];
  if (summary.kind === "participants" || summary.kind === "suppliers") {
    lines.push(`${summary.created} added, ${summary.updated} updated.`);
  } else {
    lines.push(`${plural(summary.rankingsWritten, "ranking")} written, ${summary.rankingsDeleted} from earlier files removed.`);
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
  const blocked = blockedReason(props);

  const apply = async () => {
    const result = await applyImportAction(props.importId);
    if (!result.ok) {
      toast.error(result.error.message);
      router.refresh();
      return;
    }
    setSummary(result.data.summary);
    toast.success(`${KIND_LABELS[props.kind]} applied.`);
    router.refresh();
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
    <div className="flex flex-col items-start gap-2">
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
      {blocked ? <p className="text-sm text-muted-foreground">{blocked}</p> : null}
    </div>
  );
}
