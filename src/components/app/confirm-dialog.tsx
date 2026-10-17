"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type ConfirmDialogProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Button label. Say what happens: "Disable account", "Delete event". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive actions get the destructive button style. */
  destructive?: boolean;
  /** When set, the user has to type this word before the confirm button enables. */
  confirmWord?: string;
  /**
   * Runs when confirmed. The dialog stays open with a spinner until it settles,
   * then closes. If it throws, the dialog stays open and shows an error so the
   * user can try again or cancel.
   */
  onConfirm: () => void | Promise<void>;
  /** Uncontrolled: pass a trigger element. Controlled: pass open and onOpenChange. */
  trigger?: React.ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  confirmWord,
  onConfirm,
  trigger,
  open,
  onOpenChange,
}: ConfirmDialogProps) {
  const [typed, setTyped] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // Uncontrolled (trigger only): the dialog owns its open state, so it can close itself once the work settles.
  const [innerOpen, setInnerOpen] = React.useState(false);
  const isOpen = open ?? innerOpen;
  const inputId = React.useId();

  const ready = !confirmWord || typed.trim() === confirmWord;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setTyped("");
      setFailed(false);
    }
    setInnerOpen(next);
    onOpenChange?.(next);
  };

  const handleConfirm = async (event: React.MouseEvent<HTMLButtonElement>) => {
    // Keep the dialog open until the work settles so the spinner is visible.
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setFailed(false);
    try {
      await onConfirm();
      handleOpenChange(false);
    } catch (error) {
      console.error(error);
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {confirmWord ? (
          <Field>
            <FieldLabel htmlFor={inputId}>
              Type <span className="font-semibold">{confirmWord}</span> to continue
            </FieldLabel>
            <Input
              id={inputId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoFocus
              disabled={pending}
            />
            <FieldDescription>This cannot be undone.</FieldDescription>
          </Field>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            That didn&apos;t finish. Reload the page to see what was saved, then try again if you need to.
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={!ready || pending}
            onClick={handleConfirm}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
