"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
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
import { eventSchema, type EventInput } from "@/lib/schemas/event";
import { createEvent } from "@/server/events/actions";

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const TIMEZONES = Intl.supportedValuesOf("timeZone");

export function CreateEventDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<EventInput>({
    resolver: zodResolver(eventSchema),
    defaultValues: { name: "", eventDate: "", timezone: DEFAULT_TIMEZONE },
  });

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const onSubmit = async (values: EventInput) => {
    const result = await createEvent(values);
    if (!result.ok) {
      const fieldErrors = result.error.fieldErrors ?? {};
      for (const [key, messages] of Object.entries(fieldErrors)) {
        setError(key as keyof EventInput, { message: messages[0] });
      }
      if (Object.keys(fieldErrors).length === 0) toast.error(result.error.message);
      return;
    }
    toast.success("Event created.");
    setOpen(false);
    reset();
    router.push(`/events/${result.data.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon data-icon="inline-start" />
          Create event
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Create event</DialogTitle>
            <DialogDescription>Slot times and thresholds start from the 2025 defaults. Change them in Settings.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="event-name">Name</FieldLabel>
              <Input id="event-name" placeholder="AW 2026" autoFocus aria-invalid={!!errors.name} {...register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.eventDate}>
              <FieldLabel htmlFor="event-date">Show date</FieldLabel>
              <Input id="event-date" type="date" aria-invalid={!!errors.eventDate} {...register("eventDate")} />
              <FieldError errors={[errors.eventDate]} />
            </Field>
            <Controller
              control={control}
              name="timezone"
              render={({ field }) => (
                <Field data-invalid={!!errors.timezone}>
                  <FieldLabel htmlFor="event-timezone">Timezone</FieldLabel>
                  <Combobox items={TIMEZONES} value={field.value} onValueChange={(value) => field.onChange(value ?? "")}>
                    <ComboboxInput
                      id="event-timezone"
                      placeholder="Search timezones"
                      aria-invalid={!!errors.timezone}
                      onBlur={field.onBlur}
                      className="w-full"
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>No timezone matches.</ComboboxEmpty>
                      <ComboboxList>
                        {(item: string) => (
                          <ComboboxItem key={item} value={item}>
                            {item}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                  <FieldError errors={[errors.timezone]} />
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
              Create event
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
