import { ArrowLeftIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isEmailConfigured } from "@/lib/email/adapter";
import { isEditorCompatibleHtml, sanitizeEmailHtml } from "@/lib/email/sanitize-html";
import { eventAllows } from "@/lib/event-gates";
import { formatTimestamp } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { emailSetup } from "@/server/email/campaigns";
import { getAudienceOptions, getCampaign } from "@/server/email/queries";
import { getEvent } from "@/server/events/queries";
import { eventSectionHref } from "../../event-sections";
import { DuplicateAsReminderButton } from "../campaign-buttons";
import {
  audiencePhrase,
  CampaignStatusBadge,
  emailSetupReason,
  KIND_LABELS,
  MESSAGE_STATUS_LABELS,
  NOT_DELIVERED_NOTICE,
  recipients,
} from "../labels";
import { CampaignEditor } from "./campaign-editor";
import { DeliveryTable, RefreshStatusButton, RetryDeliveryButton, type DeliveryTableRow } from "./delivery-table";
import { EmailPreview } from "./email-preview";

const NOT_LOCKED = "Lock the schedule before sending so every link is final.";
const ARCHIVED = "This event is archived.";
const TALLY_STATUSES = ["delivered", "sent", "queued", "bounced", "complained", "failed"] as const;

export default async function CampaignPage({ params }: { params: Promise<{ id: string; campaignId: string }> }) {
  const { user: admin } = await requireSession();
  const { id, campaignId } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const detail = /^[0-9a-f-]{36}$/i.test(campaignId) ? await getCampaign(campaignId) : null;
  if (!detail || detail.campaign.eventId !== event.id) notFound();
  const { campaign, messages, stats } = detail;
  const canSend = eventAllows("locked", event.status);
  const archived = event.status === "archived";
  const setup = emailSetup();
  const sendBlockedReason = archived ? ARCHIVED : canSend ? null : NOT_LOCKED;
  // Retrying delivery sends mail too, so it needs the same setup as a first send.
  const retryBlockedReason = sendBlockedReason ?? emailSetupReason(setup, campaign.fromEmail, { retry: true });
  const at = (date: Date) => formatTimestamp(date, event.timezone);
  const backHref = eventSectionHref(event.id, "emails");
  const archivedBanner = archived ? (
    <Alert>
      <LockIcon />
      <AlertTitle>This event is archived</AlertTitle>
      <AlertDescription>
        <p>You can read this campaign, but it can&apos;t be edited, sent, or retried.</p>
      </AlertDescription>
    </Alert>
  ) : null;

  const header = (
    <PageHeader
      title={campaign.name}
      status={<CampaignStatusBadge status={campaign.status} />}
      description={`${KIND_LABELS[campaign.kind]} email to ${audiencePhrase(campaign.audience)}`}
      actions={
        <>
          <Button variant="ghost" asChild>
            <Link href={backHref}>
              <ArrowLeftIcon data-icon="inline-start" />
              All campaigns
            </Link>
          </Button>
          {campaign.status === "draft" ? null : (
            <>
              <RetryDeliveryButton
                campaignId={campaign.id}
                count={detail.resendable}
                disabledReason={retryBlockedReason}
              />
              <DuplicateAsReminderButton campaignId={campaign.id} disabledReason={archived ? ARCHIVED : null} />
            </>
          )}
        </>
      }
    />
  );

  if (campaign.status === "draft") {
    const options = await getAudienceOptions(event.id);
    if (!options) notFound();
    return (
      <>
        {header}
        {archivedBanner}
        <CampaignEditor
          campaignId={campaign.id}
          initial={{
            name: campaign.name,
            fromName: campaign.fromName,
            fromEmail: campaign.fromEmail,
            replyTo: campaign.replyTo,
            subject: campaign.subject,
            htmlBody: campaign.htmlBody,
            audience: campaign.audience,
            selectedRecipients: campaign.selectedRecipients,
          }}
          options={options}
          // Designed HTML the visual editor would flatten opens as source, so a save can't lose it.
          initialHtmlMode={!isEditorCompatibleHtml(campaign.htmlBody)}
          sendBlockedReason={sendBlockedReason}
          emailSetup={setup}
          archived={archived}
          adminEmail={admin.email}
          testSentLabel={campaign.testSentAt ? `Test sent ${at(campaign.testSentAt)}.` : null}
        />
      </>
    );
  }

  const rows: DeliveryTableRow[] = messages.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    status: m.status,
    lastEvent: m.lastEvent
      ? `${MESSAGE_STATUS_LABELS[m.lastEvent.type as keyof typeof MESSAGE_STATUS_LABELS] ?? sentenceCase(m.lastEvent.type)}, ${at(new Date(m.lastEvent.at))}`
      : null,
    reason: m.reason,
    attempts: m.attempts,
  }));
  const facts: [string, string][] = [
    ["Sent", campaign.sentAt ? `${at(campaign.sentAt)}${detail.sentByName ? ` by ${detail.sentByName}` : ""}` : "Not sent"],
    ["Recipients", recipients(campaign.recipientCount ?? stats.total)],
    ["From", `${campaign.fromName} <${campaign.fromEmail}>`],
    ["Reply-to", campaign.replyTo],
    ["Subject", campaign.subject],
  ];
  // One tile per status in the table below, under the table's own word, so the two always agree.
  const tally = TALLY_STATUSES.map((status): [string, number] => [MESSAGE_STATUS_LABELS[status], stats[status]]);

  return (
    <>
      {header}
      {archivedBanner}
      {isEmailConfigured() ? null : (
        <Alert>
          <AlertTitle>These emails were logged, not delivered</AlertTitle>
          <AlertDescription>
            {NOT_DELIVERED_NOTICE} The statuses below show what the app recorded, not what reached an inbox.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="font-display text-lg font-bold">Delivery</CardTitle>
            <CardDescription>
              Statuses update when you reload the page or use Refresh status. Sent campaigns can&apos;t be edited.
            </CardDescription>
            <CardAction>
              <RefreshStatusButton />
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {tally.map(([label, value]) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="font-display text-2xl font-bold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              {facts.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="font-display text-lg font-bold">Message</CardTitle>
            <CardDescription>As written, with merge fields not filled in.</CardDescription>
          </CardHeader>
          <CardContent>
            <EmailPreview sanitizedHtml={sanitizeEmailHtml(campaign.htmlBody)} />
          </CardContent>
        </Card>
      </div>
      <DeliveryTable rows={rows} />
    </>
  );
}

function sentenceCase(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
