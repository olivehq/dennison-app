import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { EmailAudience, EmailCampaignKind } from "@/lib/schemas/email";
import type { EmailSetup } from "@/server/email/campaigns";
import { EMAIL_NOT_CONFIGURED_MESSAGE, isExampleAddress } from "@/server/email/merge";

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

/** The toast after a send that left out people whose link was revoked. */
export function skippedRevokedMessage(count: number): string {
  const who = count === 1 ? "1 person was" : `${count} people were`;
  return `${who} skipped because their link was revoked. Use Regenerate on the roster to give someone a new link.`;
}

/** Shown when mail only went to the server log (no email provider): the campaign page and the send toast. */
export const NOT_DELIVERED_NOTICE = "This server has no email provider set up.";

export const EXAMPLE_SENDER_REASON =
  "The From email is on example.com, which no mail provider will send from. Change it to an address on your verified sending domain.";

/** A sent campaign can't be edited, so retrying one from example.com means sending a copy. */
export const EXAMPLE_SENDER_RETRY_REASON =
  "This campaign's From email is on example.com, which no mail provider will send from. Duplicate it, change the From email to an address on your verified sending domain, and send the copy.";

/**
 * Why a send, test, or retry would be refused for the deployment or the
 * sender, or null. Same rules as the server, so the buttons say so before the click.
 */
export function emailSetupReason(setup: EmailSetup, fromEmail: string, { retry = false } = {}): string | null {
  if (!setup.configured) return EMAIL_NOT_CONFIGURED_MESSAGE;
  if (setup.refuseExampleSender && isExampleAddress(fromEmail)) return retry ? EXAMPLE_SENDER_RETRY_REASON : EXAMPLE_SENDER_REASON;
  return null;
}

/** The toast after a send: what went out, or that nothing did. */
export function sentMessage(count: number, delivered: boolean): string {
  if (delivered) return `Sent to ${recipients(count)}.`;
  return `Logged ${count} ${count === 1 ? "email" : "emails"}, not sent. ${NOT_DELIVERED_NOTICE}`;
}
