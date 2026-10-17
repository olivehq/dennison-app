"use client";

import * as React from "react";
import { CheckIcon, RefreshCwIcon, RepeatIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { activateRunAction, runMatchingAction } from "@/server/matching/actions";

function headline(stats: {
  totalAppointments: number;
  supplierSuccessPct: number;
  buyersInRangePct: number;
  mutualTopN: { pct: number };
  thresholds: { mutualTopN: number };
}): string {
  return `${stats.totalAppointments} appointments. ${stats.supplierSuccessPct}% of suppliers at target, ${stats.buyersInRangePct}% of buyers in range, ${stats.mutualTopN.pct}% mutual top ${stats.thresholds.mutualTopN}.`;
}

/** "Run matching" and "Re-run and keep existing appointments", each behind a confirm. */
export function RunMatchingButtons({
  eventId,
  hasActiveRun,
  disabled,
}: {
  eventId: string;
  hasActiveRun: boolean;
  disabled: boolean;
}) {
  const router = useRouter();

  const run = async (keepExisting: boolean) => {
    const result = await runMatchingAction(eventId, { keepExisting });
    if (!result.ok) {
      toast.error(result.error.message);
      router.refresh();
      return;
    }
    const { stats, isActive, keptCount, warnings } = result.data;
    toast.success(isActive ? "Matching finished. This run is now the schedule." : "Matching finished. Compare it, then activate it.", {
      description: [
        headline(stats),
        keepExisting ? `${keptCount} existing ${keptCount === 1 ? "appointment" : "appointments"} kept.` : null,
        warnings.length ? `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}.` : null,
      ]
        .filter(Boolean)
        .join(" "),
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ConfirmDialog
        title="Run matching?"
        description={
          hasActiveRun
            ? "This builds a new schedule from scratch from the current rankings and settings. Pins and edits in the current schedule are not carried over. The schedule everyone sees stays as it is until you activate the new run, so you can compare first."
            : "This builds a schedule from scratch from the current rankings and settings. There is no active schedule, so it becomes the schedule straight away."
        }
        confirmLabel="Run matching"
        onConfirm={() => run(false)}
        trigger={
          <Button size="lg" disabled={disabled}>
            <RefreshCwIcon data-icon="inline-start" />
            Run matching
          </Button>
        }
      />
      <ConfirmDialog
        title="Re-run and keep existing appointments?"
        description="This keeps the appointments in the active schedule where they are and fills every open slot, whether the slot opened through a removal, a replacement, or a withdrawal. Pinned appointments stay pinned. It only adds meetings, except that appointments with a withdrawn buyer or supplier are left out. The result is a new run you can compare before activating."
        confirmLabel="Re-run and keep existing"
        onConfirm={() => run(true)}
        trigger={
          <Button size="lg" variant="outline" disabled={disabled || !hasActiveRun}>
            <RepeatIcon data-icon="inline-start" />
            Re-run and keep existing appointments
          </Button>
        }
      />
    </div>
  );
}

/** Makes a completed run the schedule everyone sees. The confirm shows what changes against the active run. */
export function ActivateRunButton({
  runId,
  disabled,
  preview,
  expectedActiveRunId,
  expectedVersion,
}: {
  runId: string;
  disabled: boolean;
  /** Counts against the active run; null when no run is active yet. */
  preview: { added: number; removed: number; countChanges: number } | null;
  /** The active run and version the counts were read from; null when none. A change since is a conflict. */
  expectedActiveRunId: string | null;
  expectedVersion: number | null;
}) {
  const router = useRouter();
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const summary = preview
    ? preview.added === 0 && preview.removed === 0
      ? "It has the same appointments as the current schedule, so nobody's schedule changes."
      : `Against the current schedule it adds ${plural(preview.added, "appointment", "appointments")}, removes ${preview.removed}, and changes the meeting count of ${plural(preview.countChanges, "person", "people")}.`
    : null;
  return (
    <ConfirmDialog
      title="Activate this run?"
      description={[
        summary,
        "It replaces the current schedule in the workspace, exports, and participant pages. The run it replaces is kept here and can be activated again. Anyone editing the current schedule will be asked to reload.",
      ]
        .filter(Boolean)
        .join(" ")}
      confirmLabel="Activate this run"
      onConfirm={async () => {
        const result = await activateRunAction({ runId, expectedActiveRunId, expectedVersion });
        if (!result.ok) {
          toast.error(result.error.message);
          router.refresh();
          return;
        }
        toast.success("Run activated", { description: "The schedule now shows this run." });
      }}
      trigger={
        <Button size="sm" variant="outline" disabled={disabled}>
          <CheckIcon data-icon="inline-start" />
          Activate this run
        </Button>
      }
    />
  );
}
