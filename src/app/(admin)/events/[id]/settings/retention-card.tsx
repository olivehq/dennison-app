"use client";

import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { setRetainData } from "@/server/events/actions";

/**
 * Its own card and its own save, outside the settings form: D&A usually asks
 * to keep data after the show, when the rest of the settings are read-only.
 */
export function RetentionCard({
  eventId,
  retainData,
  deleteOn,
  archived,
  purged,
  overdue,
}: {
  eventId: string;
  retainData: boolean;
  /** The day the cron deletes the data when the switch is off, already formatted. */
  deleteOn: string;
  archived: boolean;
  /** The retention job has deleted the data (an `event.retention_delete` row exists). */
  purged: boolean;
  /** The 90 days have passed, so the next daily run deletes the data. */
  overdue: boolean;
}) {
  const [checked, setChecked] = React.useState(retainData);
  const [pending, startTransition] = React.useTransition();
  const [confirmingOff, setConfirmingOff] = React.useState(false);
  const when = overdue ? "at the next daily cleanup, within a day" : `on ${deleteOn}`;

  const save = async (next: boolean) => {
    setChecked(next);
    const result = await setRetainData(eventId, next);
    if (!result.ok) {
      setChecked(!next);
      toast.error(result.error.message);
      return;
    }
    toast.success(next ? "Participant data will be kept." : `Participant data will be deleted ${when}.`);
  };

  // Turning it off schedules deletion, so that direction asks first.
  const change = (next: boolean) => {
    if (next) startTransition(() => save(true));
    else setConfirmingOff(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Participant data</CardTitle>
        <CardDescription>
          Participant data is deleted or returned to D&amp;A within 90 days after the event unless D&amp;A asks in writing
          to keep it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal" data-disabled={archived || pending} className="max-w-xl">
          <Switch id="retainData" checked={checked} onCheckedChange={change} disabled={archived || pending} />
          <FieldContent>
            <FieldLabel htmlFor="retainData">Keep participant data after 90 days</FieldLabel>
            <FieldDescription>
              {purged
                ? "This event is archived. Its participant data has been deleted."
                : archived
                  ? checked
                    ? "This event is archived. Its participant data is kept, as D&A asked."
                    : `This event is archived. Its participant data is deleted ${when}.`
                  : checked
                    ? "Kept until someone turns this off. Turn it on only when D&A has asked in writing."
                    : `Names, emails, rankings, schedules, links, uploaded files, and email logs for this event are deleted ${when}.`}
            </FieldDescription>
          </FieldContent>
        </Field>
        <ConfirmDialog
          open={confirmingOff}
          onOpenChange={setConfirmingOff}
          title="Stop keeping participant data?"
          description={`Names, emails, rankings, schedules, links, uploaded files, and email logs for this event will be deleted ${when}. Turn this back on before then to keep them.`}
          confirmLabel="Stop keeping data"
          destructive
          onConfirm={() => save(false)}
        />
      </CardContent>
    </Card>
  );
}
