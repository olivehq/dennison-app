"use client";

import { Undo2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActivityUndo } from "@/server/audit/queries";
import { undoAuditAction } from "@/server/schedule/actions";

export function UndoButton({ auditEventId, sentence, undo }: { auditEventId: string; sentence: string; undo: ActivityUndo }) {
  const router = useRouter();

  if (!undo.available) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer events, so the tooltip hangs on a focusable wrapper. */}
          <span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Button variant="outline" size="sm" disabled aria-label={`Undo. ${undo.reason}`}>
              <Undo2Icon data-icon="inline-start" />
              Undo
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">{undo.reason}</TooltipContent>
      </Tooltip>
    );
  }

  const confirm = async () => {
    const result = await undoAuditAction({ auditEventId });
    if (!result.ok) {
      toast.error(result.error.message);
      router.refresh();
      return;
    }
    const affected = result.data.affected.map((p) => `${p.name}: ${p.before} → ${p.after}`).join(". ");
    toast.success("Change undone", { description: affected });
    router.refresh();
  };

  return (
    <ConfirmDialog
      title="Undo this change?"
      description={`${sentence}. Undoing it puts the schedule back the way it was, if that still passes the scheduling rules. The undo shows in this log too.`}
      confirmLabel="Undo change"
      onConfirm={confirm}
      trigger={
        <Button variant="outline" size="sm">
          <Undo2Icon data-icon="inline-start" />
          Undo
        </Button>
      }
    />
  );
}
