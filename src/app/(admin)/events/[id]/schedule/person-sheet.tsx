"use client";

import * as React from "react";
import { AlertTriangleIcon, ArrowLeftIcon, PinIcon, PinOffIcon, PlusIcon, RepeatIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "cn";
import { TYPE_LABEL, typeDotClass } from "@/components/app/appointment-block";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
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
import { EditPreviewPanel, previewSentence } from "./edit-preview";
import {
  describeEdit,
  healthOf,
  healthText,
  openSlotsText,
  personLabel,
  pickerRequestFor,
  sheetRows,
  type EditDraft,
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

  // No router.refresh() after a save: the actions call revalidatePath, so the
  // action response already carries the fresh page. A second request was one
  // more slow round trip racing the admin's next clicks.
  const finish = (result: ActionResult<EditResult>, success: string) => {
    if (!result.ok) {
      onError(result.error);
      return false;
    }
    onVersion(result.data.version);
    toast.success(success, { description: affectedLine(result.data) });
    return true;
  };

  // Picking someone opens a preview; Save commits it. Tied to the request so a new picker starts clean.
  const [draft, setDraft] = React.useState<{ request: PickerRequest; candidate: SwapCandidate } | null>(null);
  const activeDraft = draft && draft.request === picker ? draft : null;
  const preview = activeDraft ? describeEdit(model, draftFor(model, activeDraft.request, activeDraft.candidate)) : null;
  const [removing, setRemoving] = React.useState<SheetRow | null>(null);
  // After a replace: offer to open the schedule of the buyer who lost the slot.
  const [followUp, setFollowUp] = React.useState<{ personId: string; name: string; slot: number } | null>(null);

  const pick = (candidate: SwapCandidate) => {
    if (picker) setDraft({ request: picker, candidate });
  };

  const save = () => {
    if (!activeDraft) return;
    const { request: picker, candidate } = activeDraft;
    const removeBuyerId = picker.pick === "buyer" ? picker.removeBuyerId : undefined;
    startTransition(async () => {
      const result = removeBuyerId
        ? await replaceAppointmentAction({
            runId,
            version,
            slot: picker.slot,
            supplierId: candidate.supplierId,
            removeBuyerId,
            addBuyerId: candidate.buyerId,
          })
        : await addAppointmentAction({
            runId,
            version,
            slot: picker.slot,
            supplierId: candidate.supplierId,
            buyerId: candidate.buyerId,
          });
      const verb =
        picker.pick === "buyer" && picker.removeBuyerId
          ? `Replaced ${picker.removeBuyerName} with ${candidate.name}`
          : `Added ${candidate.name}`;
      if (finish(result, `${verb} in slot ${picker.slot}`)) {
        setDraft(null);
        onPickerChange(null);
        const removed = removeBuyerId ? model.personById.get(removeBuyerId) : undefined;
        // A withdrawn buyer's sheet has no Add button, so there is nothing to follow up on.
        if (removeBuyerId && removeBuyerId !== person?.id && !removed?.withdrawn) {
          setFollowUp({
            personId: removeBuyerId,
            name: removed ? personLabel(removed).primary : (picker.pick === "buyer" && picker.removeBuyerName) || "the buyer",
            slot: picker.slot,
          });
        }
      }
    });
  };

  const remove = async (row: SheetRow) => {
    const a = row.appointment;
    if (!a) return;
    setBusyRow(a.id);
    try {
      const result = await removeAppointmentAction({ runId, version, slot: a.slot, supplierId: a.supplierId, buyerId: a.buyerId });
      const supplier = model.personById.get(a.supplierId);
      finish(result, `Removed. ${supplier?.name ?? "The supplier"} is open in slot ${a.slot}`);
    } finally {
      setBusyRow(null);
    }
  };
  const removal = removing?.appointment
    ? describeEdit(model, { supplierId: removing.appointment.supplierId, slot: removing.appointment.slot, removeBuyerId: removing.appointment.buyerId })
    : null;

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
      toast.success(result.data.pinned ? `Pinned slot ${a.slot}.` : `Unpinned slot ${a.slot}.`, {
        description: result.data.pinned ? "Marked as reviewed. A pin doesn't change matching." : undefined,
      });
    });
  };

  const requestFor = (row: SheetRow, replace: boolean): PickerRequest | null =>
    person ? pickerRequestFor(model, person, row, replace) : null;

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
      // A withdrawn person gets no new meetings, so there is nothing to add.
      if (!editing || person.withdrawn) return null;
      return (
        <Button size="xs" variant="outline" disabled={isPending} onClick={() => onPickerChange(requestFor(row, false))}>
          <PlusIcon data-icon="inline-start" />
          {person.kind === "supplier" ? "Add buyer" : "Add supplier"}
        </Button>
      );
    }
    return (
      <>
        {row.counterpart?.withdrawn ? (
          <Badge variant="destructive">
            <AlertTriangleIcon /> Withdrew, fix before locking
          </Badge>
        ) : null}
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
            <Button size="xs" variant="outline" disabled={isPending || busy} onClick={() => setRemoving(row)}>
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
  const openText = person ? openSlotsText(person, rows) : null;

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
                  preview ? (
                    <EditPreviewPanel preview={preview} pending={isPending} onSave={save} onCancel={() => setDraft(null)} />
                  ) : (
                    <SwapPicker request={picker} runId={runId} version={version} topN={topN} pending={isPending} onPick={pick} />
                  )
                ) : (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="font-semibold">{healthText(person, targets)}</span>
                        {openText ? <span className="text-muted-foreground">{openText}</span> : null}
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
                          {`Replace, remove, or pin a meeting, or add a ${person.kind === "supplier" ? "buyer" : "supplier"} to an open slot. You see what changes before it saves, and every change shows in the activity log.`}
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
              {/*
                The dialogs below are children of the sheet, not siblings: Radix then stacks
                them as nested layers, so each one opens above the sheet and its overlay and
                gets the focus trap, even when the sheet and a dialog open in the same click.
              */}
              <Dialog open={!isMobile && picker !== null} onOpenChange={(open) => !open && onPickerChange(null)}>
                <DialogContent className="sm:max-w-lg">
                  {picker ? (
                    <>
                      <DialogHeader className="min-w-0">
                        <DialogTitle className="font-display text-lg leading-tight font-bold break-words">
                          {pickerTitle(picker)}
                        </DialogTitle>
                        <DialogDescription className="break-words">{pickerDescription(picker)}</DialogDescription>
                      </DialogHeader>
                      {preview ? (
                        <EditPreviewPanel preview={preview} pending={isPending} onSave={save} onCancel={() => setDraft(null)} />
                      ) : (
                        <SwapPicker request={picker} runId={runId} version={version} topN={topN} pending={isPending} onPick={pick} />
                      )}
                    </>
                  ) : null}
                </DialogContent>
              </Dialog>
              <ConfirmDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                title="Remove this meeting?"
                description={removal ? `${previewSentence(removal)} The slot stays open until you fill it.` : undefined}
                confirmLabel="Remove meeting"
                destructive
                onConfirm={() => (removing ? remove(removing) : undefined)}
              />
              <ConfirmDialog
                open={followUp !== null}
                onOpenChange={(open) => !open && setFollowUp(null)}
                title={followUp ? `Open ${followUp.name}'s schedule?` : "Open schedule?"}
                description={
                  followUp ? `${followUp.name} is now open in slot ${followUp.slot}. Open their schedule to fill it.` : undefined
                }
                confirmLabel="Open schedule"
                cancelLabel="Stay here"
                onConfirm={() => {
                  if (followUp) onSelect(followUp.personId, followUp.slot);
                }}
              />
            </>
          ) : (
            <SheetTitle className="sr-only">Schedule</SheetTitle>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The edit a picked candidate makes, in the shape `describeEdit` previews. */
function draftFor(model: ScheduleModel, request: PickerRequest, candidate: SwapCandidate): EditDraft {
  if (request.pick === "buyer") {
    return {
      supplierId: candidate.supplierId,
      slot: request.slot,
      removeBuyerId: request.removeBuyerId,
      add: { buyerId: candidate.buyerId, name: candidate.name, count: candidate.count, countAfter: candidate.countAfter },
    };
  }
  const count = model.personById.get(request.buyerId)?.count ?? 0;
  return {
    supplierId: candidate.supplierId,
    slot: request.slot,
    add: { buyerId: request.buyerId, name: request.buyerName, count, countAfter: count + 1 },
  };
}
