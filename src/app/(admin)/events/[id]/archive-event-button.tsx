"use client";

import { ArchiveIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { archiveEventAction } from "@/server/events/actions";

/** "Archive event" for events that can't be deleted. Archived events refuse every change; exports keep working. */
export function ArchiveEventButton({ eventId, eventName }: { eventId: string; eventName: string }) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-2 border-t pt-6">
      <p className="text-sm text-muted-foreground">
        Archive the event when the show is over. Nothing can change after that, and exports stay available.
      </p>
      <ConfirmDialog
        title="Archive this event?"
        description={`${eventName} becomes read-only: no imports, matching, edits, links, or emails. Exports keep working. Participant data is still deleted 90 days after the event unless you chose to keep it.`}
        confirmLabel="Archive event"
        confirmWord={eventName}
        destructive
        trigger={
          <Button variant="outline" className="self-start">
            <ArchiveIcon data-icon="inline-start" />
            Archive event
          </Button>
        }
        onConfirm={async () => {
          const result = await archiveEventAction(eventId);
          if (!result.ok) {
            toast.error(result.error.message);
            router.refresh();
            return;
          }
          toast.success("Event archived.");
          router.refresh();
        }}
      />
    </div>
  );
}
