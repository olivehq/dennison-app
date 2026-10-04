"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { deleteEvent } from "@/server/events/actions";

export function DeleteEventButton({ eventId, eventName }: { eventId: string; eventName: string }) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-2 border-t pt-6">
      <p className="text-sm text-muted-foreground">
        A draft with no participants can be deleted. Events with data can be archived from the overview instead.
      </p>
      <ConfirmDialog
        title="Delete this event?"
        description={`${eventName} and its settings will be removed. The audit log keeps a record.`}
        confirmLabel="Delete event"
        confirmWord={eventName}
        destructive
        trigger={
          <Button variant="destructive" className="self-start">
            Delete event
          </Button>
        }
        onConfirm={async () => {
          const result = await deleteEvent(eventId);
          if (!result.ok) {
            toast.error(result.error.message);
            return;
          }
          toast.success("Event deleted.");
          router.push("/events");
        }}
      />
    </div>
  );
}
