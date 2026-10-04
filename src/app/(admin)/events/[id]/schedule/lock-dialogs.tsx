"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { lockScheduleAction, unlockScheduleAction } from "@/server/schedule/actions";

type LockOutcome = { desks: number; links: number };

/** Lock: explains what happens, runs it, then shows how many desks and links it produced. */
export function LockDialog({
  open,
  onOpenChange,
  eventId,
  appointments,
  buyersBelowMin,
  buyerMin,
  withdrawn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  appointments: number;
  buyersBelowMin: number;
  buyerMin: number;
  /** Appointments naming someone who withdrew. Lock refuses while there are any. */
  withdrawn: number;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<LockOutcome | null>(null);

  const close = (next: boolean) => {
    if (pending) return;
    if (!next) setOutcome(null);
    onOpenChange(next);
  };

  const lock = async (event: React.MouseEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      const result = await lockScheduleAction({ eventId });
      if (!result.ok) {
        toast.error(result.error.message);
        router.refresh();
        return;
      }
      setOutcome({
        desks: result.data.desks.filter((d) => d.desk !== null).length,
        links: result.data.tokensIssued,
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        {outcome ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Schedule locked</AlertDialogTitle>
              <AlertDialogDescription>
                {outcome.desks === 1 ? "1 desk" : `${outcome.desks} desks`} assigned and{" "}
                {outcome.links === 1 ? "1 participant link" : `${outcome.links} participant links`} issued. Editing and re-running
                are off until you unlock.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction onClick={() => close(false)}>Done</AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Lock this schedule?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="flex flex-col gap-2">
                  <p>Locking freezes all {appointments} appointments so they can be exported and emailed. It will:</p>
                  <ul className="flex list-disc flex-col gap-1 pl-5">
                    <li>Assign desk numbers alphabetically by supplier name. Desk overrides are kept.</li>
                    <li>Issue a private schedule link for every buyer and supplier.</li>
                    <li>Turn off editing and re-running until someone unlocks it.</li>
                  </ul>
                  <p>
                    {buyersBelowMin
                      ? `${buyersBelowMin === 1 ? "1 buyer is" : `${buyersBelowMin} buyers are`} still below ${buyerMin} meetings.`
                      : "Every buyer is within target."}
                  </p>
                  {withdrawn ? (
                    <p className="font-semibold text-destructive">
                      {withdrawn === 1
                        ? "1 appointment involves someone who withdrew. Re-run matching keeping existing appointments, or remove it, before locking."
                        : `${withdrawn} appointments involve someone who withdrew. Re-run matching keeping existing appointments, or remove them, before locking.`}
                    </p>
                  ) : null}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={pending || withdrawn > 0} onClick={lock}>
                {pending ? <Spinner data-icon="inline-start" /> : null}
                Lock schedule
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Unlock: needs a reason, which goes in the activity log. */
export function UnlockDialog({
  open,
  onOpenChange,
  eventId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
}) {
  const router = useRouter();
  const reasonId = React.useId();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const close = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setReason("");
      setError(null);
    }
    onOpenChange(next);
  };

  const unlock = async (event: React.MouseEvent) => {
    event.preventDefault();
    if (reason.trim() === "") {
      setError("Say why you are unlocking.");
      return;
    }
    setPending(true);
    try {
      const result = await unlockScheduleAction({ eventId, reason });
      if (!result.ok) {
        const fieldError = result.error.fieldErrors?.reason?.[0];
        if (fieldError) setError(fieldError);
        else toast.error(result.error.message);
        return;
      }
      toast.success("Schedule unlocked", { description: "Editing and re-running are available again." });
      router.refresh();
      setPending(false);
      close(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unlock this schedule?</AlertDialogTitle>
          <AlertDialogDescription>
            Editing and re-running come back. Desk numbers and participant links stay as they are. If schedules were already
            sent, people who change will need an update email.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={reasonId}>Reason</FieldLabel>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            maxLength={500}
            placeholder="A supplier sent a different attendee"
            disabled={pending}
            autoFocus
          />
          {error ? <FieldError>{error}</FieldError> : <FieldDescription>Saved in the activity log.</FieldDescription>}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={unlock}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Unlock schedule
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
