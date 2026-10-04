import { Badge } from "@/components/ui/badge";
import type { EventStatus } from "@/lib/schemas/event";

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  draft: "Draft",
  imported: "Imported",
  matched: "Matched",
  locked: "Locked",
  sent: "Sent",
  archived: "Archived",
};

const VARIANTS: Record<EventStatus, "outline" | "secondary" | "default"> = {
  draft: "outline",
  imported: "secondary",
  matched: "secondary",
  locked: "default",
  sent: "default",
  archived: "outline",
};

export function EventStatusBadge({ status }: { status: EventStatus }) {
  return <Badge variant={VARIANTS[status]}>{EVENT_STATUS_LABELS[status]}</Badge>;
}
