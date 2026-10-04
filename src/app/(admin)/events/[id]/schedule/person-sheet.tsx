"use client";

import * as React from "react";
import { AlertTriangleIcon, ArrowLeftIcon, PinIcon, PinOffIcon, PlusIcon, RepeatIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "cn";
import { TYPE_LABEL, typeDotClass } from "@/components/app/appointment-block";
import { PersonSchedule, type PersonScheduleSlot } from "@/components/app/person-schedule";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/hooks/use-mobile";
import type { ActionError, ActionResult } from "@/lib/errors";
import { VERSION_CONFLICT_MESSAGE } from "@/lib/schemas/schedule";
import { setPinnedAction } from "@/server/matching/actions";
import { addAppointmentAction, removeAppointmentAction, replaceAppointmentAction } from "@/server/schedule/actions";
import type { EditResult, SwapCandidate } from "@/server/schedule/edits";
import type { ScheduleSlot } from "@/server/schedule/queries";
import {
  healthOf,
  healthText,
  personLabel,
  sheetRows,
  type Person,
  type ScheduleModel,
  type SheetRow,
  type SupplierPerson,
  type Targets,
} from "./schedule-model";
import { pickerDescription, pickerTitle, SwapPicker, type PickerRequest } from "./swap-picker";

type PersonSheetProps = {
  person: Person | null;
  model: ScheduleModel;
  slots: ScheduleSlot[];
  targets: Targets;
  topN: number;
  editing: boolean;
  runId: string;
  version: number;
  focusSlot: number | null;
  picker: PickerRequest | null;
  onPickerChange: (request: PickerRequest | null) => void;
  onVersion: (version: number) => void;
  onSelect: (personId: string, slot?: number) => void;
  onClose: () => void;
};

/** Toasts an action failure. A stale version or a lock means the view is out of date, so it reloads. */
export function useEditErrors() {
  const router = useRouter();
  return React.useCallback(
    (error: ActionError) => {
      toast.error(error.message);
      if ((error.code === "conflict" && error.message === VERSION_CONFLICT_MESSAGE) || error.code === "locked") {
        router.refresh();
      }
    },
    [router],
  );
}

function affectedLine(result: EditResult): string {
  return result.affected.map((p) => `${p.name}: ${p.before} → ${p.after}`).join(". ");
}

export function PersonSheet(props: PersonSheetProps) {
  const { person, model, slots, targets, topN, editing, runId, version, focusSlot, picker, onPickerChange, onVersion, onSelect, onClose } =
    props;
  const router = useRouter();
  const isMobile = useIsMobile();
  const onError = useEditErrors();
  const [isPending, startTransition] = React.useTransition();
  const [busyRow, setBusyRow] = React.useState<string | null>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);

  const rows = React.useMemo(() => (person ? sheetRows(model, person, slots) : []), [model, person, slots]);

  React.useEffect(() => {
    if (!person || !focusSlot) return;
    const frame = requestAnimationFrame(() => {
      bodyRef.current?.querySelector(`[data-slot-n="${focusSlot}"]`)?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [person, focusSlot]);

  const finish = (result: ActionResult<EditResult>, success: string) => {
    if (!result.ok) {
      onError(result.error);
      return false;
    }
    onVersion(result.data.version);
    toast.success(success, { description: affectedLine(result.data) });
    router.refresh();
    return true;
  };

  const pick = (candidate: SwapCandidate) => {
    if (!picker) return;
    startTransition(async () => {
      const result = picker.removeBuyerId
        ? await replaceAppointmentAction({
            runId,
            version,
            slot: picker.slot,
            supplierId: picker.supplierId,
            removeBuyerId: picker.removeBuyerId,
            addBuyerId: candidate.buyerId,
          })
        : await addAppointmentAction({
            runId,
            version,
            slot: picker.slot,
            supplierId: picker.supplierId,
            buyerId: candidate.buyerId,
          });
      const verb = picker.removeBuyerId ? `Replaced ${picker.removeBuyerName} with ${candidate.name}` : `Added ${candidate.name}`;
      if (finish(result, `${verb} in slot ${picker.slot}`)) onPickerChange(null);
    });
  };

  const remove = (row: SheetRow) => {
    const a = row.appointment;
    if (!a) return;
    setBusyRow(a.id);
    startTransition(async () => {
      const result = await removeAppointmentAction({ runId, version, slot: a.slot, supplierId: a.supplierId, buyerId: a.buyerId });
      setBusyRow(null);
      const supplier = model.personById.get(a.supplierId);
      finish(result, `Removed. ${supplier?.name ?? "The supplier"} is open in slot ${a.slot}`);
    });
  };

  const togglePin = (row: SheetRow) => {
    const a = row.appointment;
    if (!a) return;
    setBusyRow(a.id);
    startTransition(async () => {
      const result = await setPinnedAction({ appointmentId: a.id, pinned: !a.pinned, version });
      setBusyRow(null);
      if (!result.ok) {
        onError(result.error);
        return;
      }
      onVersion(result.data.version);
      toast.success(result.data.pinned ? `Pinned slot ${a.slot}` : `Unpinned slot ${a.slot}`, {
        description: result.data.pinned ? "The next re-run keeps this meeting." : "The next re-run may move this meeting.",
      });
      router.refresh();
    });
  };

  const requestFor = (row: SheetRow, replace: boolean): PickerRequest | null => {
    if (!person) return null;
    const supplier = (person.kind === "supplier" ? person : row.counterpart) as SupplierPerson | null;
    if (!supplier) return null;
    const buyer = row.appointment ? model.personById.get(row.appointment.buyerId) : undefined;
    return {
      supplierId: supplier.id,
      supplierName: supplier.name,
      slot: row.slot.slot,
      slotLabel: `${row.slot.start} to ${row.slot.end}`,
      removeBuyerId: replace ? buyer?.id : undefined,
      removeBuyerName: replace && buyer ? personLabel(buyer).primary : undefined,
    };
  };

  const scheduleSlots: PersonScheduleSlot[] = rows.map((r) => {
    if (!r.appointment || !r.counterpart) return { slot: r.slot.slot, start: r.slot.start, end: r.slot.end, appointment: null };
    const supplier = (person?.kind === "supplier" ? person : r.counterpart) as SupplierPerson;
    return {
      slot: r.slot.slot,
      start: r.slot.start,
      end: r.slot.end,
      appointment: {
        counterpartName: r.counterpart.name,
        desk: supplier.desk,
        buyerRank: r.appointment.buyerRank,
        supplierRank: r.appointment.supplierRank,
        strength: r.appointment.strength,
        counterpartType: r.counterpart.kind === "supplier" ? r.counterpart.type : undefined,
      },
    };
  });

  const renderActions = (s: PersonScheduleSlot) => {
    const row = rows.find((r) => r.slot.slot === s.slot);
    if (!row || !person) return null;
    const a = row.appointment;
    const busy = a !== null && busyRow === a.id;
    if (!a) {
      if (!editing || person.kind !== "supplier") return null;
      return (
        <Button size="xs" variant="outline" disabled={isPending} onClick={() => onPickerChange(requestFor(row, false))}>
          <PlusIcon data-icon="inline-start" />
          Add buyer
        </Button>
      );
    }
    return (
      <>
        {row.counterpart ? (
          <Button size="xs" variant="outline" onClick={() => onSelect(row.counterpart!.id, a.slot)}>
            Open {row.counterpart.kind}
          </Button>
        ) : null}
        {editing ? (
          <>
            <Button size="xs" variant="outline" disabled={isPending} onClick={() => onPickerChange(requestFor(row, true))}>
              <RepeatIcon data-icon="inline-start" />
              Replace
            </Button>
            <Button size="xs" variant="outline" disabled={isPending} onClick={() => remove(row)}>
              {busy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
              Remove
            </Button>
            <Button size="xs" variant="outline" disabled={isPending} aria-pressed={a.pinned} onClick={() => togglePin(row)}>
              {a.pinned ? <PinOffIcon data-icon="inline-start" /> : <PinIcon data-icon="inline-start" />}
              {a.pinned ? "Unpin" : "Pin"}
            </Button>
          </>
        ) : null}
        {a.pinned && !editing ? (
          <Badge variant="outline" className="bg-background/70">
            <PinIcon /> Pinned
          </Badge>
        ) : null}
        {a.source === "manual" ? (
          <Badge variant="outline" className="bg-background/70">
            Placed by hand
          </Badge>
        ) : null}
      </>
    );
  };

  const inlinePicker = isMobile && picker !== null;
  const health = person ? healthOf(person, targets) : "ok";
  const label = person ? personLabel(person) : null;
  const max = person?.kind === "supplier" ? targets.supplierTarget : targets.buyerMax;
  const openCount = rows.filter((r) => !r.appointment).length;

  return (
    <>
      <Sheet open={person !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent
          side="right"
          className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[480px]"
        >
          {person && label ? (
            <>
              <SheetHeader className="border-b px-5 pt-5 pb-4">
                {inlinePicker && picker ? (
                  <>
                    <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => onPickerChange(null)}>
                      <ArrowLeftIcon data-icon="inline-start" />
                      Back to {label.primary}
                    </Button>
                    <SheetTitle className="font-display text-xl leading-tight font-bold text-balance">{pickerTitle(picker)}</SheetTitle>
                    <SheetDescription>{pickerDescription(picker)}</SheetDescription>
                  </>
                ) : (
                  <>
                    <SheetTitle className="pr-8 font-display text-xl leading-tight font-bold text-balance">{label.primary}</SheetTitle>
                    <SheetDescription className="flex flex-wrap items-center gap-2">
                      {person.kind === "supplier" ? (
                        <>
                          <span className="inline-grid h-6 min-w-7 place-items-center rounded-sm bg-secondary px-1 font-display text-[13px] font-bold text-secondary-foreground tabular-nums">
                            {person.desk ?? "–"}
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <span aria-hidden="true" className={cn("size-2 rounded-[2px]", typeDotClass(person.type))} />
                            {TYPE_LABEL[person.type]} supplier, {person.desk === null ? "desk assigned at lock" : `desk ${person.desk}`}
                          </span>
                        </>
                      ) : (
                        <>
                          {label.secondary ? <span>{label.secondary}</span> : null}
                          <Badge variant={person.biztechOptIn ? "secondary" : "outline"}>
                            {person.biztechOptIn ? "Biztech opted in" : "Not opted in to biztech"}
                          </Badge>
                        </>
                      )}
                      {person.withdrawn ? <Badge variant="destructive">Withdrawn</Badge> : null}
                    </SheetDescription>
                  </>
                )}
              </SheetHeader>
              <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {inlinePicker && picker ? (
                  <SwapPicker request={picker} runId={runId} version={version} topN={topN} pending={isPending} onPick={pick} />
                ) : (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="font-semibold">{healthText(person, targets)}</span>
                        <span className="text-muted-foreground">
                          {openCount ? `${openCount} open ${openCount === 1 ? "slot" : "slots"}` : "No open slots"}
                        </span>
                      </div>
                      <Progress
                        value={(person.count / Math.max(1, slots.length)) * 100}
                        aria-label="Meetings booked"
                        className={cn(
                          "h-2",
                          (health === "under" || health === "off") && "*:data-[slot=progress-indicator]:bg-destructive",
                          health === "over" && "*:data-[slot=progress-indicator]:bg-warning",
                        )}
                      />
                      {health !== "ok" ? (
                        <Alert variant="destructive">
                          <AlertTriangleIcon />
                          <AlertDescription>
                            {person.kind === "supplier"
                              ? `This desk should have ${targets.supplierTarget}.`
                              : health === "under"
                                ? `Below the minimum of ${targets.buyerMin}. The open slots below are where another supplier could go.`
                                : `Above the maximum of ${max}. Move a meeting to a buyer below target.`}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                      {editing ? (
                        <p className="text-sm text-muted-foreground">
                          {person.kind === "supplier"
                            ? "Replace, remove, or pin a meeting, or add a buyer to an open slot. Each change saves straight away and shows in the activity log."
                            : "Replace, remove, or pin a meeting. To fill an open slot, open a supplier who is free then."}
                        </p>
                      ) : null}
                    </div>
                    <PersonSchedule
                      slots={scheduleSlots}
                      personType={person.kind}
                      personSupplierType={person.kind === "supplier" ? person.type : undefined}
                      showRanks
                      topN={topN}
                      focusSlot={focusSlot ?? undefined}
                      renderActions={renderActions}
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <SheetTitle className="sr-only">Schedule</SheetTitle>
          )}
        </SheetContent>
      </Sheet>
      <Dialog open={!isMobile && picker !== null} onOpenChange={(open) => !open && onPickerChange(null)}>
        <DialogContent className="sm:max-w-lg">
          {picker ? (
            <>
              <DialogHeader>
                <DialogTitle className="font-display text-lg font-bold">{pickerTitle(picker)}</DialogTitle>
                <DialogDescription>{pickerDescription(picker)}</DialogDescription>
              </DialogHeader>
              <SwapPicker request={picker} runId={runId} version={version} topN={topN} pending={isPending} onPick={pick} />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
