import { LockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTimestamp } from "@/lib/time";
import { getEmailSummary, listCampaigns } from "@/server/email/queries";
import { getEvent } from "@/server/events/queries";
import { eventSectionHref } from "../event-sections";
import { NewCampaignButton, SendUpdateButton } from "./campaign-buttons";
import { CampaignsTable, type CampaignTableRow } from "./campaigns-table";
import { people } from "./labels";

export default async function EmailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const [campaigns, summary] = await Promise.all([listCampaigns(event.id), getEmailSummary(event.id)]);
  const canSend = event.status === "locked" || event.status === "sent";
  const archived = event.status === "archived";

  const rows: CampaignTableRow[] = campaigns.map((c) => ({
    id: c.id,
    href: `${eventSectionHref(event.id, "emails")}/${c.id}`,
    name: c.name,
    kind: c.kind,
    audience: c.audience,
    status: c.status,
    recipients: c.recipientCount,
    // Accepted by the provider, whatever happened after.
    sent: c.counts.total - c.counts.queued - c.counts.failed,
    delivered: c.counts.delivered + c.counts.complained,
    bounced: c.counts.bounced,
    sentAt: c.sentAt ? formatTimestamp(c.sentAt, event.timezone) : null,
    sentAtTime: c.sentAt?.getTime() ?? 0,
  }));

  return (
    <>
      <PageHeader
        title="Emails"
        description="Email buyers and supplier contacts their private schedule link, then follow delivery."
        actions={<NewCampaignButton eventId={event.id} disabled={archived} />}
      />
      {!canSend && !archived ? (
        <Alert>
          <LockIcon />
          <AlertTitle>The schedule isn&apos;t locked</AlertTitle>
          <AlertDescription>
            <p>
              Lock the schedule before sending so every link is final. You can write campaigns and send tests now.{" "}
              <Link href={eventSectionHref(event.id, "schedule")} className="underline underline-offset-4">
                Go to the schedule
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {summary.hasSent ? (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle className="font-display text-lg font-bold">
              {summary.changed > 0
                ? `${people(summary.changed)} changed since their last email`
                : "Everyone has their latest schedule"}
            </CardTitle>
            <CardDescription>
              {summary.changed > 0
                ? "Their appointments, times, or desks differ from the schedule in the last email they got. Send them an update with their link."
                : "When an edit changes someone's schedule after they were emailed, they show up here."}
            </CardDescription>
            <CardAction>
              <SendUpdateButton eventId={event.id} disabled={summary.changed === 0 || archived} />
            </CardAction>
          </CardHeader>
        </Card>
      ) : null}
      <CampaignsTable rows={rows} />
    </>
  );
}
