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

export function NewCampaignButton({ eventId, disabled }: { eventId: string; disabled?: boolean }) {
  const { pending, run } = useCreateAndOpen();
  return (
    <Button onClick={() => run(() => createCampaignAction({ eventId, kind: "initial" }))} disabled={disabled || pending}>
      {pending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
      New campaign
    </Button>
  );
}

/** Creates an update campaign for the people whose schedule changed since their last email, and opens it. */
export function SendUpdateButton({
  eventId,
  disabled,
  variant = "default",
}: {
  eventId: string;
  disabled?: boolean;
  variant?: "default" | "outline";
}) {
  const { pending, run } = useCreateAndOpen();
  return (
    <Button
      variant={variant}
      onClick={() => run(() => createCampaignAction({ eventId, kind: "update" }))}
      disabled={disabled || pending}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <MailPlusIcon data-icon="inline-start" />}
      Send update
    </Button>
  );
}

export function DuplicateAsReminderButton({ campaignId }: { campaignId: string }) {
  const { pending, run } = useCreateAndOpen();
  return (
    <Button
      variant="outline"
      onClick={() => run(() => duplicateCampaignAction({ campaignId, kind: "reminder" }))}
      disabled={pending}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      Duplicate as reminder
    </Button>
  );
}
