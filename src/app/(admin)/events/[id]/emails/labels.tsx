import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { EmailAudience, EmailCampaignKind } from "@/lib/schemas/email";

/** Words for the emails pages, in one place so every screen says the same thing. */

export type CampaignStatus = "draft" | "sending" | "sent" | "failed";
export type MessageStatus = "queued" | "sent" | "delivered" | "bounced" | "complained" | "failed";

export const KIND_LABELS: Record<EmailCampaignKind, string> = {
  initial: "Schedule",
  reminder: "Reminder",
  update: "Update",
};

export const AUDIENCE_LABELS: Record<EmailAudience, string> = {
  all: "Everyone",
  buyers: "Buyers",
  suppliers: "Supplier contacts",
  selected: "Selected people",
  changed_since_last_send: "Changed since last email",
};

const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <Badge variant={status === "sent" ? "default" : status === "failed" ? "destructive" : status === "draft" ? "outline" : "secondary"}>
      {CAMPAIGN_STATUS_LABELS[status]}
    </Badge>
  );
}

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  complained: "Marked as spam",
  failed: "Failed",
};

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  const problem = status === "bounced" || status === "complained" || status === "failed";
  return (
    <Badge
      variant={problem ? "destructive" : status === "delivered" ? "secondary" : "outline"}
      className={cn(status === "queued" && "text-muted-foreground")}
    >
      {MESSAGE_STATUS_LABELS[status]}
    </Badge>
  );
}

/** "1 person", "3 people". */
export function people(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

/** "1 recipient", "3 recipients". */
export function recipients(count: number): string {
  return `${count} ${count === 1 ? "recipient" : "recipients"}`;
}
