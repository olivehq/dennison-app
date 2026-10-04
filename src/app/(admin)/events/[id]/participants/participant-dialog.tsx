"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { participantSchema } from "@/lib/schemas/roster";
import { saveParticipant } from "@/server/roster/actions";
import { applyActionError } from "../_roster/form-errors";

type FormInput = z.input<typeof participantSchema>;
type FormOutput = z.output<typeof participantSchema>;

const FIELDS = ["email", "firstName", "lastName", "organization", "title", "biztechOptIn"] as const;

export type ParticipantFormData = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  organization: string | null;
  title: string | null;
  displayName: string | null;
  biztechOptIn: boolean;
};

function defaults(participant: ParticipantFormData | null): FormInput {
  return {
    email: participant?.email ?? "",
    firstName: participant?.firstName ?? "",
    lastName: participant?.lastName ?? "",
    organization: participant?.organization ?? "",
    title: participant?.title ?? "",
    // Not edited here, but sent back so saving doesn't clear it.
    displayName: participant?.displayName ?? null,
    biztechOptIn: participant?.biztechOptIn ?? false,
  };
}

type ParticipantDialogProps = {
  eventId: string;
  /** Null to add a participant. */
  participant: ParticipantFormData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ParticipantDialog({ eventId, participant, open, onOpenChange }: ParticipantDialogProps) {
  const router = useRouter();
  const editing = participant !== null;
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(participantSchema),
    defaultValues: defaults(participant),
  });

  React.useEffect(() => {
    if (open) reset(defaults(participant));
  }, [open, participant, reset]);

  const onSubmit = async (values: FormOutput) => {
    const result = await saveParticipant({ ...values, eventId, id: participant?.id });
    if (!result.ok) {
      applyActionError(result.error, setError, FIELDS);
      if (result.error.code === "locked") router.refresh();
      return;
    }
    const emailChanged = editing && participant.email !== values.email;
    toast.success(
      editing
        ? emailChanged
          ? "Participant saved. Their old link was revoked because the email changed."
          : "Participant saved."
        : `${values.firstName} ${values.lastName} added.`,
    );
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit participant" : "Add participant"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Changing the email revokes their current schedule link."
                : "Email identifies the participant. A later participants file with the same email updates this row."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="participant-email">Email</FieldLabel>
              <Input
                id="participant-email"
                type="email"
                autoComplete="off"
                autoFocus
                aria-invalid={!!errors.email}
                {...register("email")}
              />
              <FieldError errors={[errors.email]} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.firstName}>
                <FieldLabel htmlFor="participant-first">First name</FieldLabel>
                <Input id="participant-first" autoComplete="off" aria-invalid={!!errors.firstName} {...register("firstName")} />
                <FieldError errors={[errors.firstName]} />
              </Field>
              <Field data-invalid={!!errors.lastName}>
                <FieldLabel htmlFor="participant-last">Last name</FieldLabel>
                <Input id="participant-last" autoComplete="off" aria-invalid={!!errors.lastName} {...register("lastName")} />
                <FieldError errors={[errors.lastName]} />
              </Field>
            </div>
            <Field data-invalid={!!errors.organization}>
              <FieldLabel htmlFor="participant-org">Organization</FieldLabel>
              <Input id="participant-org" autoComplete="off" aria-invalid={!!errors.organization} {...register("organization")} />
              <FieldError errors={[errors.organization]} />
            </Field>
            <Field data-invalid={!!errors.title}>
              <FieldLabel htmlFor="participant-title">Title</FieldLabel>
              <Input id="participant-title" autoComplete="off" aria-invalid={!!errors.title} {...register("title")} />
              <FieldDescription>With the organization, this is how they appear on schedules, for example “Acme - Director”.</FieldDescription>
              <FieldError errors={[errors.title]} />
            </Field>
            <Controller
              control={control}
              name="biztechOptIn"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="participant-biztech">Biztech opt-in</FieldLabel>
                    <FieldDescription>Only opted-in participants are matched with business suppliers.</FieldDescription>
                  </FieldContent>
                  <Switch
                    id="participant-biztech"
                    checked={field.value ?? false}
                    onCheckedChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              {editing ? "Save participant" : "Add participant"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
