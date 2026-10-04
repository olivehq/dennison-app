"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { supplierContactSchema, supplierSchema } from "@/lib/schemas/roster";
import { saveSupplier } from "@/server/roster/actions";
import { applyActionError } from "../_roster/form-errors";

const DESK_MESSAGE = "Enter a desk number from 1 to 999, or leave it blank.";

/** Both contact fields blank means no contact; otherwise both must be valid. */
const contactInput = z
  .object({ name: z.string().trim(), email: z.string().trim() })
  .transform((contact) => (contact.name === "" && contact.email === "" ? null : contact))
  .pipe(supplierContactSchema.nullable());

/** The module schema with form-shaped inputs: the desk as text, contacts as two text fields. */
const supplierFormSchema = supplierSchema.extend({
  deskNumber: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : Number(value)))
    .pipe(z.int(DESK_MESSAGE).min(1, DESK_MESSAGE).max(999, DESK_MESSAGE).nullable()),
  adminContact: contactInput,
  attendeeContact: contactInput,
});

type FormInput = z.input<typeof supplierFormSchema>;
type FormOutput = z.output<typeof supplierFormSchema>;

const FIELDS = [
  "name",
  "type",
  "deskNumber",
  "adminContact.name",
  "adminContact.email",
  "attendeeContact.name",
  "attendeeContact.email",
] as const;

export type SupplierFormData = {
  id: string;
  name: string;
  type: "business" | "hotel";
  deskNumber: number | null;
  deskOverride: boolean;
  adminContactName: string | null;
  adminContactEmail: string | null;
  attendeeContactName: string | null;
  attendeeContactEmail: string | null;
};

function defaults(supplier: SupplierFormData | null): FormInput {
  return {
    name: supplier?.name ?? "",
    type: supplier?.type ?? "hotel",
    deskNumber: supplier?.deskNumber != null ? String(supplier.deskNumber) : "",
    deskOverride: supplier?.deskOverride ?? false,
    adminContact: { name: supplier?.adminContactName ?? "", email: supplier?.adminContactEmail ?? "" },
    attendeeContact: { name: supplier?.attendeeContactName ?? "", email: supplier?.attendeeContactEmail ?? "" },
  };
}

type SupplierDialogProps = {
  eventId: string;
  /** Null to add a supplier. */
  supplier: SupplierFormData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SupplierDialog({ eventId, supplier, open, onOpenChange }: SupplierDialogProps) {
  const router = useRouter();
  const editing = supplier !== null;
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(supplierFormSchema),
    defaultValues: defaults(supplier),
  });

  React.useEffect(() => {
    if (open) reset(defaults(supplier));
  }, [open, supplier, reset]);

  const onSubmit = async (values: FormOutput) => {
    const result = await saveSupplier({ ...values, eventId, id: supplier?.id });
    if (!result.ok) {
      applyActionError(result.error, setError, FIELDS);
      if (result.error.code === "locked") router.refresh();
      return;
    }
    const emailsChanged =
      editing &&
      ((supplier.adminContactEmail ?? null) !== (values.adminContact?.email ?? null) ||
        (supplier.attendeeContactEmail ?? null) !== (values.attendeeContact?.email ?? null));
    toast.success(
      editing
        ? emailsChanged
          ? "Supplier saved. Links for the changed contact emails were revoked."
          : "Supplier saved."
        : `${values.name} added.`,
    );
    onOpenChange(false);
    router.refresh();
  };

  const contactFields = (key: "adminContact" | "attendeeContact", legend: string, hint: string) => {
    const fieldErrors = errors[key];
    return (
      <FieldSet>
        <FieldLegend variant="label">{legend}</FieldLegend>
        <FieldDescription>{hint}</FieldDescription>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={!!fieldErrors?.name}>
            <FieldLabel htmlFor={`supplier-${key}-name`}>Name</FieldLabel>
            <Input id={`supplier-${key}-name`} autoComplete="off" aria-invalid={!!fieldErrors?.name} {...register(`${key}.name`)} />
            <FieldError errors={[fieldErrors?.name]} />
          </Field>
          <Field data-invalid={!!fieldErrors?.email}>
            <FieldLabel htmlFor={`supplier-${key}-email`}>Email</FieldLabel>
            <Input
              id={`supplier-${key}-email`}
              type="email"
              autoComplete="off"
              aria-invalid={!!fieldErrors?.email}
              {...register(`${key}.email`)}
            />
            <FieldError errors={[fieldErrors?.email]} />
          </Field>
        </div>
      </FieldSet>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit supplier" : "Add supplier"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Changing a contact email revokes that contact's schedule link."
                : "The name identifies the supplier. A later suppliers file with the same name updates this row."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="supplier-name">Name</FieldLabel>
              <Input id="supplier-name" autoComplete="off" autoFocus aria-invalid={!!errors.name} {...register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Field data-invalid={!!errors.type}>
                    <FieldLabel htmlFor="supplier-type">Type</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="supplier-type" className="w-full" aria-invalid={!!errors.type} onBlur={field.onBlur}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="hotel">Hotel</SelectItem>
                          <SelectItem value="business">Business</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>Only biztech opted-in participants meet business suppliers.</FieldDescription>
                    <FieldError errors={[errors.type]} />
                  </Field>
                )}
              />
              <Field data-invalid={!!errors.deskNumber}>
                <FieldLabel htmlFor="supplier-desk">Desk number</FieldLabel>
                <Input
                  id="supplier-desk"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="Assigned at lock"
                  aria-invalid={!!errors.deskNumber}
                  {...register("deskNumber")}
                />
                <FieldDescription>A number here is kept when desks are assigned at lock.</FieldDescription>
                <FieldError errors={[errors.deskNumber]} />
              </Field>
            </div>
            {contactFields("adminContact", "Admin contact", "Gets the supplier's schedule link.")}
            {contactFields("attendeeContact", "Attendee contact", "The person at the desk. Gets their own link.")}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              {editing ? "Save supplier" : "Add supplier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
