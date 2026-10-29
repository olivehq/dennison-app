"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { BrandedHeader } from "@/components/app/branded-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { brandingColorsSchema, LOGO_ACCEPT, LOGO_MAX_BYTES, LOGO_TYPES, type LogoType } from "@/lib/branding";
import { saveEventBranding } from "@/server/events/actions";

type FormValues = z.input<typeof brandingColorsSchema>;

const HEX = /^#[0-9a-f]{6}$/i;

/** A color picker next to a hex field. Empty means no color. */
function ColorField({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled: boolean;
}) {
  return (
    <Field data-invalid={error ? true : undefined} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          type="color"
          aria-label={`${label} picker`}
          className="h-9 w-12 shrink-0 cursor-pointer p-1"
          value={HEX.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
        <Input
          id={id}
          className="max-w-32 font-mono"
          placeholder="#1d4ed8"
          maxLength={7}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
        />
        {value ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")} disabled={disabled}>
            Clear
          </Button>
        ) : null}
      </div>
      {error ? <FieldError>{error}</FieldError> : <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );
}

/**
 * Logo and colors for the page participants and suppliers open from their
 * links. Its own card and save, like the retention switch, because the page
 * stays editable after the schedule is locked. The preview is the real
 * header the participant page renders.
 */
export function BrandingCard({
  eventId,
  eventName,
  dateLabel,
  colors,
  logoSrc,
  archived,
}: {
  eventId: string;
  eventName: string;
  /** The event date, already formatted. */
  dateLabel: string;
  colors: FormValues;
  /** The saved logo's URL. */
  logoSrc: string | null;
  archived: boolean;
}) {
  const form = useForm<FormValues>({ resolver: zodResolver(brandingColorsSchema), defaultValues: colors });
  const { control, handleSubmit, setError, formState } = form;
  const [pending, startTransition] = React.useTransition();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = React.useState(false);
  const newLogoSrc = React.useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  React.useEffect(() => () => {
    if (newLogoSrc) URL.revokeObjectURL(newLogoSrc);
  }, [newLogoSrc]);

  const primary = useWatch({ control, name: "primaryColor" });
  const accent = useWatch({ control, name: "accentColor" });
  const previewLogo = file ? newLogoSrc : removeLogo ? null : logoSrc;
  const dirty = formState.isDirty || file !== null || removeLogo;

  const pickFile = (picked: File | null) => {
    setFileError(null);
    if (picked && !LOGO_TYPES.includes(picked.type as LogoType)) {
      setFileError("Upload a PNG, JPEG, WebP, or SVG logo.");
      if (fileInput.current) fileInput.current.value = "";
      setFile(null);
      return;
    }
    if (picked && picked.size > LOGO_MAX_BYTES) {
      setFileError("The logo is larger than 300 KB. Shrink it or export a smaller file.");
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setFile(picked);
    if (picked) setRemoveLogo(false);
  };

  const submit = handleSubmit((values) =>
    startTransition(async () => {
      const data = new FormData();
      data.set("primaryColor", values.primaryColor);
      data.set("accentColor", values.accentColor);
      if (file) data.set("logo", file);
      data.set("removeLogo", String(removeLogo));
      const result = await saveEventBranding(eventId, data);
      if (!result.ok) {
        for (const [key, messages] of Object.entries(result.error.fieldErrors ?? {})) {
          if (key === "logo") setFileError(messages[0]);
          else if (key === "primaryColor" || key === "accentColor") setError(key, { message: messages[0] });
        }
        toast.error(result.error.message);
        return;
      }
      // The saved page remounts this card (its key is the saved branding), clearing the form.
      const cleared = !values.primaryColor && !values.accentColor && !previewLogo;
      toast.success(
        cleared
          ? "Branding removed. Participant schedule pages show the plain header."
          : "Branding saved. Participant schedule pages now show it.",
      );
    }),
  );

  const disabled = archived || pending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedule page branding</CardTitle>
        <CardDescription>
          Add a logo and one or two colors. Participants and suppliers see them at the top of the schedule page they
          open from their link.
        </CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent>
          <div className="grid gap-6 lg:grid-cols-2">
            <FieldGroup>
              <Field data-invalid={fileError ? true : undefined} data-disabled={disabled}>
                <FieldLabel htmlFor="logo">Logo</FieldLabel>
                <Input
                  id="logo"
                  ref={fileInput}
                  type="file"
                  accept={LOGO_ACCEPT}
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  aria-invalid={fileError ? true : undefined}
                  disabled={disabled}
                />
                {fileError ? (
                  <FieldError>{fileError}</FieldError>
                ) : (
                  <FieldDescription>PNG, JPEG, WebP, or SVG, up to 300 KB. A wide logo on a plain background works best.</FieldDescription>
                )}
                {logoSrc && !file ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() => setRemoveLogo((v) => !v)}
                    disabled={disabled}
                  >
                    {removeLogo ? "Keep logo" : "Remove logo"}
                  </Button>
                ) : null}
              </Field>
              <Controller
                control={control}
                name="primaryColor"
                render={({ field, fieldState }) => (
                  <ColorField
                    id="primaryColor"
                    label="Main color"
                    hint="Colors the top border and background tint of the header, and the supplier's desk badge."
                    value={field.value}
                    onChange={field.onChange}
                    error={fieldState.error?.message}
                    disabled={disabled}
                  />
                )}
              />
              <Controller
                control={control}
                name="accentColor"
                render={({ field, fieldState }) => (
                  <ColorField
                    id="accentColor"
                    label="Accent color (optional)"
                    hint="Colors the edge of each booked appointment. Left empty, it uses the main color."
                    value={field.value}
                    onChange={field.onChange}
                    error={fieldState.error?.message}
                    disabled={disabled}
                  />
                )}
              />
            </FieldGroup>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Preview</p>
              <div className="flex flex-col gap-3 rounded-md border bg-background p-4">
                <BrandedHeader
                  eventName={eventName}
                  dateLabel={dateLabel}
                  name="Sample Supplier"
                  desk={5}
                  primaryColor={HEX.test(primary) ? primary : null}
                  logoSrc={previewLogo}
                />
                <div
                  className="rounded-md border border-l-4 bg-card px-3 py-2 text-sm font-bold"
                  style={HEX.test(accent || primary) ? { borderLeftColor: accent || primary } : undefined}
                >
                  Sample Association - Meeting Planner
                </div>
              </div>
            </div>
          </div>
        </CardContent>
        <CardFooter className="gap-3">
          <Button type="submit" disabled={disabled || !dirty}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Save branding
          </Button>
          {archived ? <p className="text-sm text-muted-foreground">This event is archived. Its branding can&apos;t change.</p> : null}
        </CardFooter>
      </form>
    </Card>
  );
}
