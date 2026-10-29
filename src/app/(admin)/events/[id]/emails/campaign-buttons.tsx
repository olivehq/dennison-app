"use client";

import * as React from "react";
import { CopyIcon, MailPlusIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ActionResult } from "@/lib/errors";
import { createCampaignAction, duplicateCampaignAction } from "@/server/email/actions";

type Created = ActionResult<{ campaignId: string; eventId: string }>;

/** Runs an action that creates a draft, then opens the draft. */
function useCreateAndOpen() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const run = async (create: () => Promise<Created>) => {
    setPending(true);
    try {
      const result = await create();
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      router.push(`/events/${result.data.eventId}/emails/${result.data.campaignId}`);
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

export function NewCampaignButton({
  eventId,
  disabledReason = null,
}: {
  eventId: string;
  disabledReason?: string | null;
}) {
  const { pending, run } = useCreateAndOpen();
  return (
    <Button
      onClick={() => run(() => createCampaignAction({ eventId, kind: "initial" }))}
      disabled={disabledReason !== null || pending}
      title={disabledReason ?? undefined}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
      New campaign
    </Button>
  );
}

/** Creates an update campaign for the people whose schedule changed since their last email, and opens it. */
export function SendUpdateButton({
  eventId,
  disabledReason = null,
  variant = "default",
}: {
  eventId: string;
  disabledReason?: string | null;
  variant?: "default" | "outline";
}) {
  const { pending, run } = useCreateAndOpen();
  return (
    <Button
      variant={variant}
      onClick={() => run(() => createCampaignAction({ eventId, kind: "update" }))}
      disabled={disabledReason !== null || pending}
      title={disabledReason ?? undefined}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <MailPlusIcon data-icon="inline-start" />}
      Draft update
    </Button>
  );
}

/** `disabledReason` is shown as the button's title, for example on an archived event. */
export function DuplicateAsReminderButton({
  campaignId,
  disabledReason = null,
}: {
  campaignId: string;
  disabledReason?: string | null;
}) {
  const { pending, run } = useCreateAndOpen();
  return (
    <Button
      variant="outline"
      onClick={() => run(() => duplicateCampaignAction({ campaignId, kind: "reminder" }))}
      disabled={pending || disabledReason !== null}
      title={disabledReason ?? undefined}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      Duplicate as reminder
    </Button>
  );
}
