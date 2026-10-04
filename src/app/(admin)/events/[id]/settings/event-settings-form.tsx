"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { LockIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm, type FieldPath } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ActionError } from "@/lib/errors";
import { eventSchema } from "@/lib/schemas/event";
import { eventSettingsSchema, MAX_SLOT_COUNT, type EventSettings } from "@/lib/schemas/event-settings";
import { buildSlots, formatMinutes, parseClock } from "@/lib/time";
import { updateEvent, updateEventSettings } from "@/server/events/actions";

const formSchema = eventSchema.extend({ settings: eventSettingsSchema });
type FormValues = z.infer<typeof formSchema>;

const TIMEZONES = Intl.supportedValuesOf("timeZone");

const BIZTECH_RULES: { value: EventSettings["biztechOptInRule"]; label: string; hint: string }[] = [
  {
    value: "from_biztech_file",
    label: "From the biztech ranking file",
    hint: "A buyer is opted in when they appear with at least one choice in the biztech file.",
  },
  {
    value: "all_opted_in",
    label: "Everyone opted in",
    hint: "Every buyer can be matched with business suppliers.",
  },
];

/** 910 -> "15:10" for <input type="time">. */
function minutesToTimeValue(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function timeValueToMinutes(value: string, fallback: number): number {
  return parseClock(value) ?? fallback;
}

type EventForForm = {
  id: string;
  name: string;
  eventDate: string;
  timezone: string;
  settings: EventSettings;
};

function rebuildDefaults(settings: EventSettings) {
  const [first, second] = settings.slots;
  const duration = first ? first.endMinutes - first.startMinutes : 10;
  const gap = first && second ? Math.max(0, second.startMinutes - first.endMinutes) : 1;
  return {
    count: settings.slots.length,
    firstStart: first ? first.startMinutes : 15 * 60 + 10,
    duration,
    gap,
  };
}

export function EventSettingsForm({ event, readOnlyReason }: { event: EventForForm; readOnlyReason: string | null }) {
  const router = useRouter();
  const readOnly = readOnlyReason !== null;
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: event.name,
      eventDate: event.eventDate,
      timezone: event.timezone,
      settings: event.settings,
    },
  });
  const {
    register,
    control,
    handleSubmit,
    setValue,
    setError,
    reset,
    formState: { errors, isSubmitting, dirtyFields },
  } = form;
  const { fields, replace } = useFieldArray({ control, name: "settings.slots" });
  const [rebuild, setRebuild] = React.useState(() => rebuildDefaults(event.settings));

  const settingsErrors = errors.settings;
  const slotsError = settingsErrors?.slots?.message ?? settingsErrors?.slots?.root?.message;

  const applyServerError = (error: ActionError, prefix: "" | "settings.") => {
    if (error.code === "locked") {
      toast.error(error.message);
      router.refresh();
      return;
    }
    const entries = Object.entries(error.fieldErrors ?? {});
    if (entries.length === 0) {
      toast.error(error.message);
      return;
    }
    for (const [key, messages] of entries) {
      const path = (key === "_" ? prefix.replace(/\.$/, "") || "name" : `${prefix}${key}`) as FieldPath<FormValues>;
      setError(path, { message: messages[0] });
    }
    toast.error(error.message);
  };

  const onSubmit = async (values: FormValues) => {
    const detailsChanged = Boolean(dirtyFields.name || dirtyFields.eventDate || dirtyFields.timezone);
    const settingsChanged = Boolean(dirtyFields.settings);
    if (!detailsChanged && !settingsChanged) {
      toast("Nothing to save. Change a value first.");
      return;
    }
    if (detailsChanged) {
      const result = await updateEvent(event.id, {
        name: values.name,
        eventDate: values.eventDate,
        timezone: values.timezone,
      });
      if (!result.ok) {
        applyServerError(result.error, "");
        return;
      }
    }
    if (settingsChanged) {
      const result = await updateEventSettings(event.id, values.settings);
      if (!result.ok) {
        applyServerError(result.error, "settings.");
        return;
      }
    }
    toast.success("Settings saved.");
    reset(values);
    router.refresh();
  };

  const applyRebuild = () => {
    try {
      const slots = buildSlots({
        count: rebuild.count,
        firstStartMinutes: rebuild.firstStart,
        durationMinutes: rebuild.duration,
        gapMinutes: rebuild.gap,
      });
      replace(slots);
      setValue("settings.slotCount", slots.length, { shouldDirty: true });
      toast(`Built ${slots.length} slots from ${formatMinutes(slots[0].startMinutes)} to ${formatMinutes(slots[slots.length - 1].endMinutes)}.`);
    } catch (error) {
      toast.error(error instanceof RangeError ? "Those numbers run past midnight. Lower the count, duration, or gap." : "Could not build slots.");
    }
  };

  const numberField = (name: FieldPath<FormValues>) => register(name, { valueAsNumber: true });

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Slot times, meeting targets, and the thresholds the matching engine uses."
        actions={
          <Button type="submit" disabled={readOnly || isSubmitting}>
            {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
            Save settings
          </Button>
        }
      />

      {readOnly ? (
        <Alert>
          <LockIcon />
          <AlertTitle>Read-only</AlertTitle>
          <AlertDescription>{readOnlyReason}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={readOnly || isSubmitting} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Event</CardTitle>
            <CardDescription>Shown on every page, export, and email.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="max-w-xl">
              <Field data-invalid={!!errors.name} data-disabled={readOnly}>
                <FieldLabel htmlFor="name">Name</FieldLabel>
                <Input id="name" aria-invalid={!!errors.name} {...register("name")} />
                <FieldError errors={[errors.name]} />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field data-invalid={!!errors.eventDate} data-disabled={readOnly}>
                  <FieldLabel htmlFor="eventDate">Show date</FieldLabel>
                  <Input id="eventDate" type="date" aria-invalid={!!errors.eventDate} {...register("eventDate")} />
                  <FieldError errors={[errors.eventDate]} />
                </Field>
                <Controller
                  control={control}
                  name="timezone"
                  render={({ field }) => (
                    <Field data-invalid={!!errors.timezone} data-disabled={readOnly}>
                      <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
                      <Combobox
                        items={TIMEZONES}
                        value={field.value}
                        onValueChange={(value) => field.onChange(value ?? "")}
                        disabled={readOnly}
                      >
                        <ComboboxInput
                          id="timezone"
                          placeholder="Search timezones"
                          aria-invalid={!!errors.timezone}
                          onBlur={field.onBlur}
                          className="w-full"
                          disabled={readOnly}
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
                      <FieldDescription>Every slot time, export, and email uses this timezone.</FieldDescription>
                      <FieldError errors={[errors.timezone]} />
                    </Field>
                  )}
                />
              </div>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Slots</CardTitle>
            <CardDescription>
              Rebuild the table from four numbers, then adjust any slot by hand. Slots must stay in order and not overlap.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <FieldSet>
              <FieldLegend variant="label">Rebuild slots</FieldLegend>
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-24">
                  <FieldLabel htmlFor="rebuild-count">Count</FieldLabel>
                  <Input
                    id="rebuild-count"
                    type="number"
                    min={1}
                    max={MAX_SLOT_COUNT}
                    value={rebuild.count}
                    onChange={(e) => setRebuild({ ...rebuild, count: Number(e.target.value) })}
                  />
                </Field>
                <Field className="w-32">
                  <FieldLabel htmlFor="rebuild-start">First start</FieldLabel>
                  <Input
                    id="rebuild-start"
                    type="time"
                    value={minutesToTimeValue(rebuild.firstStart)}
                    onChange={(e) => setRebuild({ ...rebuild, firstStart: timeValueToMinutes(e.target.value, rebuild.firstStart) })}
                  />
                </Field>
                <Field className="w-28">
                  <FieldLabel htmlFor="rebuild-duration">Minutes each</FieldLabel>
                  <Input
                    id="rebuild-duration"
                    type="number"
                    min={1}
                    max={180}
                    value={rebuild.duration}
                    onChange={(e) => setRebuild({ ...rebuild, duration: Number(e.target.value) })}
                  />
                </Field>
                <Field className="w-28">
                  <FieldLabel htmlFor="rebuild-gap">Gap between</FieldLabel>
                  <Input
                    id="rebuild-gap"
                    type="number"
                    min={0}
                    max={120}
                    value={rebuild.gap}
                    onChange={(e) => setRebuild({ ...rebuild, gap: Number(e.target.value) })}
                  />
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  onClick={applyRebuild}
                  disabled={
                    readOnly ||
                    !Number.isInteger(rebuild.count) ||
                    rebuild.count < 1 ||
                    rebuild.count > MAX_SLOT_COUNT ||
                    rebuild.duration < 1 ||
                    rebuild.gap < 0
                  }
                >
                  Rebuild slots
                </Button>
              </div>
            </FieldSet>

            <input type="hidden" {...numberField("settings.slotCount")} />
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-16">Slot</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead className="text-right">Length</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fields.map((slot, index) => {
                    const rowErrors = settingsErrors?.slots?.[index];
                    return (
                      <TableRow key={slot.id} className="hover:bg-transparent">
                        <TableCell className="font-display font-bold tabular-nums">{index + 1}</TableCell>
                        <TableCell>
                          <Controller
                            control={control}
                            name={`settings.slots.${index}.startMinutes`}
                            render={({ field }) => (
                              <Field data-invalid={!!rowErrors?.startMinutes}>
                                <FieldLabel htmlFor={`slot-${index}-start`} className="sr-only">
                                  Slot {index + 1} start
                                </FieldLabel>
                                <Input
                                  id={`slot-${index}-start`}
                                  type="time"
                                  className="w-32"
                                  aria-invalid={!!rowErrors?.startMinutes}
                                  value={minutesToTimeValue(field.value)}
                                  onChange={(e) => field.onChange(timeValueToMinutes(e.target.value, field.value))}
                                  onBlur={field.onBlur}
                                />
                                <FieldError errors={[rowErrors?.startMinutes]} />
                              </Field>
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <Controller
                            control={control}
                            name={`settings.slots.${index}.endMinutes`}
                            render={({ field }) => (
                              <Field data-invalid={!!rowErrors?.endMinutes}>
                                <FieldLabel htmlFor={`slot-${index}-end`} className="sr-only">
                                  Slot {index + 1} end
                                </FieldLabel>
                                <Input
                                  id={`slot-${index}-end`}
                                  type="time"
                                  className="w-32"
                                  aria-invalid={!!rowErrors?.endMinutes}
                                  value={minutesToTimeValue(field.value)}
                                  onChange={(e) => field.onChange(timeValueToMinutes(e.target.value, field.value))}
                                  onBlur={field.onBlur}
                                />
                                <FieldError errors={[rowErrors?.endMinutes]} />
                              </Field>
                            )}
                          />
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          <SlotLength control={control} index={index} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {slotsError ? (
              <p role="alert" className="text-sm text-destructive">
                {slotsError}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Targets</CardTitle>
            <CardDescription>How many meetings each side should get. The engine treats these as hard limits.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Field data-invalid={!!settingsErrors?.supplierTarget}>
                <FieldLabel htmlFor="supplierTarget">Meetings per supplier</FieldLabel>
                <Input id="supplierTarget" type="number" min={1} max={MAX_SLOT_COUNT} aria-invalid={!!settingsErrors?.supplierTarget} {...numberField("settings.supplierTarget")} />
                <FieldDescription>Usually every slot.</FieldDescription>
                <FieldError errors={[settingsErrors?.supplierTarget]} />
              </Field>
              <Field data-invalid={!!settingsErrors?.buyerMin}>
                <FieldLabel htmlFor="buyerMin">Buyer minimum</FieldLabel>
                <Input id="buyerMin" type="number" min={0} max={MAX_SLOT_COUNT} aria-invalid={!!settingsErrors?.buyerMin} {...numberField("settings.buyerMin")} />
                <FieldError errors={[settingsErrors?.buyerMin]} />
              </Field>
              <Field data-invalid={!!settingsErrors?.buyerIdeal}>
                <FieldLabel htmlFor="buyerIdeal">Buyer ideal</FieldLabel>
                <Input id="buyerIdeal" type="number" min={0} max={MAX_SLOT_COUNT} aria-invalid={!!settingsErrors?.buyerIdeal} {...numberField("settings.buyerIdeal")} />
                <FieldError errors={[settingsErrors?.buyerIdeal]} />
              </Field>
              <Field data-invalid={!!settingsErrors?.buyerMax}>
                <FieldLabel htmlFor="buyerMax">Buyer maximum</FieldLabel>
                <Input id="buyerMax" type="number" min={1} max={MAX_SLOT_COUNT} aria-invalid={!!settingsErrors?.buyerMax} {...numberField("settings.buyerMax")} />
                <FieldError errors={[settingsErrors?.buyerMax]} />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Thresholds</CardTitle>
            <CardDescription>Where the engine draws its lines when it scores a pair.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Field data-invalid={!!settingsErrors?.mutualTopN}>
                <FieldLabel htmlFor="mutualTopN">Mutual top N</FieldLabel>
                <Input id="mutualTopN" type="number" min={1} max={500} aria-invalid={!!settingsErrors?.mutualTopN} {...numberField("settings.mutualTopN")} />
                <FieldDescription>A pair is mutual when both sides ranked each other inside this number.</FieldDescription>
                <FieldError errors={[settingsErrors?.mutualTopN]} />
              </Field>
              <Field data-invalid={!!settingsErrors?.hotelRankCutoff}>
                <FieldLabel htmlFor="hotelRankCutoff">Hotel rank cutoff</FieldLabel>
                <Input id="hotelRankCutoff" type="number" min={1} max={500} aria-invalid={!!settingsErrors?.hotelRankCutoff} {...numberField("settings.hotelRankCutoff")} />
                <FieldDescription>Hotel choices ranked below this are not used.</FieldDescription>
                <FieldError errors={[settingsErrors?.hotelRankCutoff]} />
              </Field>
              <Controller
                control={control}
                name="settings.biztechOptInRule"
                render={({ field }) => (
                  <Field data-invalid={!!settingsErrors?.biztechOptInRule}>
                    <FieldLabel htmlFor="biztechOptInRule">Biztech opt-in</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={readOnly}>
                      <SelectTrigger id="biztechOptInRule" className="w-full" aria-invalid={!!settingsErrors?.biztechOptInRule}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {BIZTECH_RULES.map((rule) => (
                            <SelectItem key={rule.value} value={rule.value}>
                              {rule.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>{BIZTECH_RULES.find((r) => r.value === field.value)?.hint}</FieldDescription>
                    <FieldError errors={[settingsErrors?.biztechOptInRule]} />
                  </Field>
                )}
              />
            </div>
          </CardContent>
        </Card>
      </fieldset>

      {!readOnly ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
            Save settings
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function SlotLength({ control, index }: { control: ReturnType<typeof useForm<FormValues>>["control"]; index: number }) {
  return (
    <Controller
      control={control}
      name={`settings.slots.${index}`}
      render={({ field }) => {
        const minutes = field.value.endMinutes - field.value.startMinutes;
        return <>{minutes > 0 ? `${minutes} min` : "–"}</>;
      }}
    />
  );
}
