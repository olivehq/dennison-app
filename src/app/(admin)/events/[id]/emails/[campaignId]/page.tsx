import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTimestamp } from "@/lib/time";
import { requireAdmin } from "@/server/auth/session";
import { getAudienceOptions, getCampaign } from "@/server/email/queries";
import { getEvent } from "@/server/events/queries";
import { eventSectionHref } from "../../event-sections";
import { DuplicateAsReminderButton } from "../campaign-buttons";
import { AUDIENCE_LABELS, CampaignStatusBadge, KIND_LABELS, MESSAGE_STATUS_LABELS, recipients } from "../labels";
import { CampaignEditor } from "./campaign-editor";
import { DeliveryTable, ResendBouncedButton, type DeliveryTableRow } from "./delivery-table";
import { EmailPreview } from "./email-preview";

const NOT_LOCKED = "Lock the schedule before sending so every link is final.";

export default async function CampaignPage({ params }: { params: Promise<{ id: string; campaignId: string }> }) {
  const { id, campaignId } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const detail = /^[0-9a-f-]{36}$/i.test(campaignId) ? await getCampaign(campaignId) : null;
  if (!detail || detail.campaign.eventId !== event.id) notFound();
  const { campaign, messages, stats } = detail;
  const canSend = event.status === "locked" || event.status === "sent";
  const sendBlockedReason = event.status === "archived" ? "This event is archived." : canSend ? null : NOT_LOCKED;
  const at = (date: Date) => formatTimestamp(date, event.timezone);
  const backHref = eventSectionHref(event.id, "emails");

  const header = (
    <PageHeader
      title={campaign.name}
      status={<CampaignStatusBadge status={campaign.status} />}
      description={`${KIND_LABELS[campaign.kind]} email to ${AUDIENCE_LABELS[campaign.audience].toLowerCase()}`}
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
              <ResendBouncedButton
                campaignId={campaign.id}
                count={stats.bounced + stats.failed}
                disabledReason={sendBlockedReason}
              />
              <DuplicateAsReminderButton campaignId={campaign.id} />
            </>
          )}
        </>
      }
    />
  );

  if (campaign.status === "draft") {
    const [admin, options] = await Promise.all([requireAdmin(), getAudienceOptions(event.id)]);
    if (!options) notFound();
    return (
      <>
        {header}
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
          sendBlockedReason={sendBlockedReason}
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
  const tally: [string, number][] = [
    ["Delivered", stats.delivered + stats.complained],
    ["Waiting", stats.queued + stats.sent],
    ["Bounced", stats.bounced],
    ["Failed", stats.failed],
  ];

  return (
    <>
      {header}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="font-display text-lg font-bold">Delivery</CardTitle>
            <CardDescription>Updated as Resend reports each email. Sent campaigns can&apos;t be edited.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
            <EmailPreview html={campaign.htmlBody} />
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
