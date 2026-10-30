"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { adminInviteSchema, type AdminInviteInput } from "@/lib/schemas/auth";
import { inviteAdmin } from "@/server/auth/actions";

export const NO_PROVIDER_NOTE = "This server has no email provider set up. In development, the link is in the server console.";

export function InviteAdminDialog() {
  const [open, setOpen] = React.useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AdminInviteInput>({
    resolver: zodResolver(adminInviteSchema),
    defaultValues: { name: "", email: "" },
  });

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const onSubmit = async (values: AdminInviteInput) => {
    const result = await inviteAdmin(values);
    if (!result.ok) {
      const fieldErrors = result.error.fieldErrors ?? {};
      for (const [key, messages] of Object.entries(fieldErrors)) {
        setError(key as keyof AdminInviteInput, { message: messages[0] });
      }
      if (Object.keys(fieldErrors).length === 0) toast.error(result.error.message);
      // The invite was saved and now shows in the list with Resend.
      if (result.error.code === "internal") onOpenChange(false);
      return;
    }
    if (result.data.delivered) toast.success(`Invite sent to ${values.email}.`);
    else toast.warning(`Invite logged, not sent. ${NO_PROVIDER_NOTE}`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon data-icon="inline-start" />
          Invite admin
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Invite admin</DialogTitle>
            <DialogDescription>They get an email with a link that works for 7 days.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="invite-name">Name</FieldLabel>
              <Input id="invite-name" autoFocus autoComplete="off" aria-invalid={!!errors.name} {...register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input id="invite-email" type="email" autoComplete="off" aria-invalid={!!errors.email} {...register("email")} />
              <FieldError errors={[errors.email]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              Invite admin
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
