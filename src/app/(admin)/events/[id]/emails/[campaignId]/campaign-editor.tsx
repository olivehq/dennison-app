"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { SendIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  campaignFieldsSchema,
  EMAIL_AUDIENCES,
  type CampaignFields,
  type CampaignFieldsInput,
  type EmailAudience,
} from "@/lib/schemas/email";
import { previewCampaignAction, sendCampaignAction, sendTestAction, updateCampaignAction } from "@/server/email/actions";
import { findUnknownFields } from "@/server/email/merge";
import type { AudienceOptions } from "@/server/email/queries";
import { applyActionError } from "../../_roster/form-errors";
import { AUDIENCE_LABELS, recipients } from "../labels";
import { EmailPreview } from "./email-preview";
import { RecipientPicker } from "./recipient-picker";
import { RichTextEditor } from "./rich-text-editor";

const FIELDS = ["name", "fromName", "fromEmail", "replyTo", "subject", "htmlBody", "audience", "selectedRecipients"] as const;
const AUTO_RECIPIENT = "auto";
const PREVIEW_DELAY_MS = 350;

type Preview = { recipient: { key: string; name: string; email: string } | null; subject: string; html: string };

type CampaignEditorProps = {
  campaignId: string;
  initial: CampaignFieldsInput;
  options: AudienceOptions;
  /** Null when sending is allowed; otherwise why not. */
  sendBlockedReason: string | null;
  adminEmail: string;
  /** "Test sent Nov 2, 3:10 PM", or null. */
  testSentLabel: string | null;
};

export function CampaignEditor({ campaignId, initial, options, sendBlockedReason, adminEmail, testSentLabel }: CampaignEditorProps) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    getValues,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<CampaignFieldsInput, unknown, CampaignFields>({
    resolver: zodResolver(campaignFieldsSchema),
    defaultValues: initial,
  });
  const [audience, selected, subject, htmlBody] = useWatch({
    control,
    name: ["audience", "selectedRecipients", "subject", "htmlBody"],
  });

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [testOpen, setTestOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [previewKey, setPreviewKey] = React.useState(AUTO_RECIPIENT);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const contactKeys = React.useMemo(() => new Set(options.contacts.map((c) => c.key)), [options.contacts]);
  const selectedCount = (selected ?? []).filter((key) => contactKeys.has(key)).length;
  const audienceCount = (value: EmailAudience) => (value === "selected" ? selectedCount : options.counts[value]);
  const recipientCount = audienceCount(audience);
  const unknownFields = React.useMemo(() => findUnknownFields(`${subject ?? ""} ${htmlBody ?? ""}`), [subject, htmlBody]);

  // The preview follows the editor, debounced, rendered on the server with real values.
  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await previewCampaignAction({
        campaignId,
        recipient: previewKey === AUTO_RECIPIENT ? undefined : previewKey,
        subject,
        htmlBody,
      });
      if (cancelled) return;
      if (result.ok) {
        setPreview(result.data);
        setPreviewError(null);
      } else {
        setPreviewError(result.error.message);
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [campaignId, previewKey, subject, htmlBody]);

  /** Saves when there are unsaved edits. Returns false and shows errors when the save fails. */
  const save = async (values: CampaignFields, force = false): Promise<boolean> => {
    if (!isDirty && !force) return true;
    const result = await updateCampaignAction({ campaignId, fields: values });
    if (!result.ok) {
      applyActionError(result.error, setError, FIELDS);
      if (result.error.code === "conflict") router.refresh();
      return false;
    }
    reset(getValues());
    return true;
  };

  const onSave = handleSubmit(async (values) => {
    if (await save(values, true)) toast.success("Draft saved.");
  });
  const onTest = handleSubmit(async (values) => {
    if (await save(values)) setTestOpen(true);
  });
  const onSend = handleSubmit(async (values) => {
    if (await save(values)) setConfirmOpen(true);
  });

  const send = async () => {
    const result = await sendCampaignAction({ campaignId });
    if (!result.ok) {
      toast.error(result.error.message);
      router.refresh();
      return;
    }
    toast.success(`Sent to ${recipients(result.data.sent)}`);
    if (result.data.failed > 0) {
      toast.error(`${recipients(result.data.failed)} could not be sent. Use "Resend to bounced" to try again.`);
    }
    router.refresh();
  };

  const sendDisabledReason =
    sendBlockedReason ??
    (unknownFields.length > 0
      ? "Fix the unknown merge fields first."
      : recipientCount === 0
        ? audience === "changed_since_last_send"
          ? "Nobody's schedule changed since their last email."
          : "Nobody in this audience has an email address."
        : null);

  return (
    <>
      <form onSubmit={onSave} noValidate className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="font-display text-lg font-bold">Message</CardTitle>
            <CardDescription>Each person gets their own copy with their details and private schedule link.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="campaign-name">Campaign name</FieldLabel>
                <Input id="campaign-name" autoComplete="off" aria-invalid={!!errors.name} {...register("name")} />
                <FieldDescription>Only admins see this.</FieldDescription>
                <FieldError errors={[errors.name]} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={!!errors.fromName}>
                  <FieldLabel htmlFor="campaign-from-name">From name</FieldLabel>
                  <Input id="campaign-from-name" autoComplete="off" aria-invalid={!!errors.fromName} {...register("fromName")} />
                  <FieldError errors={[errors.fromName]} />
                </Field>
                <Field data-invalid={!!errors.fromEmail}>
                  <FieldLabel htmlFor="campaign-from-email">From email</FieldLabel>
                  <Input
                    id="campaign-from-email"
                    type="email"
                    autoComplete="off"
                    aria-invalid={!!errors.fromEmail}
                    {...register("fromEmail")}
                  />
                  <FieldError errors={[errors.fromEmail]} />
                </Field>
              </div>
              <FieldDescription className="-mt-4">The from address must be on the D&amp;A sending domain.</FieldDescription>
              <Field data-invalid={!!errors.replyTo}>
                <FieldLabel htmlFor="campaign-reply-to">Reply-to</FieldLabel>
                <Input
                  id="campaign-reply-to"
                  type="email"
                  autoComplete="off"
                  aria-invalid={!!errors.replyTo}
                  {...register("replyTo")}
                />
                <FieldDescription>A D&amp;A inbox someone reads. Replies from participants go here.</FieldDescription>
                <FieldError errors={[errors.replyTo]} />
              </Field>
              <Controller
                control={control}
                name="audience"
                render={({ field }) => (
                  <Field data-invalid={!!errors.selectedRecipients}>
                    <FieldLabel htmlFor="campaign-audience">Audience</FieldLabel>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={field.value}
                        onValueChange={(value) => {
                          field.onChange(value);
                          if (value === "selected") setPickerOpen(true);
                        }}
                      >
                        <SelectTrigger id="campaign-audience" className="w-72">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {EMAIL_AUDIENCES.map((value) => (
                              <SelectItem key={value} value={value}>
                                {AUDIENCE_LABELS[value]} ({audienceCount(value)})
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {field.value === "selected" ? (
                        <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
                          <UsersIcon data-icon="inline-start" />
                          Choose people
                        </Button>
                      ) : null}
                    </div>
                    <FieldDescription>
                      {field.value === "changed_since_last_send"
                        ? `${recipients(recipientCount)} whose appointments, times, or desks changed since the last email they got.`
                        : `${recipients(recipientCount)}. Withdrawn people and contacts without an email are left out.`}
                    </FieldDescription>
                    <FieldError errors={[errors.selectedRecipients]} />
                  </Field>
                )}
              />
              <Field data-invalid={!!errors.subject}>
                <FieldLabel htmlFor="campaign-subject">Subject</FieldLabel>
                <Input id="campaign-subject" autoComplete="off" aria-invalid={!!errors.subject} {...register("subject")} />
                <FieldError errors={[errors.subject]} />
              </Field>
              <Controller
                control={control}
                name="htmlBody"
                render={({ field }) => (
                  <Field data-invalid={!!errors.htmlBody}>
                    <FieldLabel htmlFor="campaign-body">Body</FieldLabel>
                    <RichTextEditor
                      id="campaign-body"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      invalid={!!errors.htmlBody}
                      aria-describedby="campaign-body-help"
                    />
                    <FieldDescription id="campaign-body-help">
                      Merge fields like {"{{first_name}}"} are filled in for each person. {"{{schedule_link}}"} becomes their
                      private link.
                    </FieldDescription>
                    <FieldError errors={[errors.htmlBody]} />
                  </Field>
                )}
              />
              {unknownFields.length > 0 ? (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>Unknown merge fields</AlertTitle>
                  <AlertDescription>
                    <p>
                      {unknownFields.join(", ")} would be sent exactly as typed. Use Insert merge field to pick one from
                      the list.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex flex-col items-start gap-3 border-t pt-(--card-spacing) pb-(--card-spacing)">
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" disabled={isSubmitting}>
                {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                Save draft
              </Button>
              <Button type="button" variant="outline" onClick={onTest} disabled={isSubmitting}>
                Send test to me
              </Button>
              <Button type="button" onClick={onSend} disabled={isSubmitting || sendDisabledReason !== null}>
                <SendIcon data-icon="inline-start" />
                Send to {recipients(recipientCount)}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {sendDisabledReason ?? (testSentLabel ? testSentLabel : "Send yourself a test before sending to everyone.")}
            </p>
          </CardFooter>
        </Card>

        <Card className="min-w-0 lg:sticky lg:top-4">
          <CardHeader>
            <CardTitle className="font-display text-lg font-bold">Preview</CardTitle>
            <CardDescription>As this person will see it. Links are shown but not opened here.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="campaign-preview-as">Preview as</FieldLabel>
              <Select value={previewKey} onValueChange={setPreviewKey}>
                <SelectTrigger id="campaign-preview-as" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={AUTO_RECIPIENT}>First in the audience</SelectItem>
                    {options.contacts.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {previewError ? (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>The preview didn&apos;t load</AlertTitle>
                <AlertDescription>{previewError}</AlertDescription>
              </Alert>
            ) : preview ? (
              <>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">To</dt>
                  <dd className="truncate">
                    {preview.recipient ? `${preview.recipient.name} <${preview.recipient.email}>` : "Sample recipient"}
                  </dd>
                  <dt className="text-muted-foreground">Subject</dt>
                  <dd className="font-medium break-words">{preview.subject}</dd>
                </dl>
                <Separator />
                <EmailPreview html={preview.html} className="[&_a]:pointer-events-none" />
              </>
            ) : (
              <div className="flex flex-col gap-2" aria-label="Loading preview">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
          </CardContent>
        </Card>
      </form>

      <RecipientPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        contacts={options.contacts}
        value={selected ?? []}
        onChange={(keys) => setValue("selectedRecipients", keys, { shouldDirty: true, shouldValidate: true })}
      />
      <SendTestDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        campaignId={campaignId}
        defaultEmail={adminEmail}
        recipient={preview?.recipient ?? null}
        onSent={() => router.refresh()}
      />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Send to ${recipients(recipientCount)}?`}
        description="Each person gets their own copy with their private schedule link. Sent emails can't be recalled."
        confirmLabel={`Send to ${recipients(recipientCount)}`}
        onConfirm={send}
      />
    </>
  );
}

function SendTestDialog({
  open,
  onOpenChange,
  campaignId,
  defaultEmail,
  recipient,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  defaultEmail: string;
  recipient: { key: string; name: string } | null;
  onSent: () => void;
}) {
  const [email, setEmail] = React.useState(defaultEmail);
  const [error, setErrorText] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const inputId = React.useId();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      const result = await sendTestAction({ campaignId, toEmail: email, recipient: recipient?.key });
      if (!result.ok) {
        setErrorText(result.error.fieldErrors?.toEmail?.[0] ?? result.error.message);
        return;
      }
      toast.success(`Test sent to ${result.data.toEmail}`);
      onOpenChange(false);
      onSent();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setEmail(defaultEmail);
          setErrorText(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Send a test</DialogTitle>
            <DialogDescription>
              {recipient
                ? `Uses ${recipient.name}'s details and link, with "[Test]" before the subject.`
                : `Uses sample details, with "[Test]" before the subject.`}
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={inputId}>Send to</FieldLabel>
            <Input
              id={inputId}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!error}
              autoFocus
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Send test
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
