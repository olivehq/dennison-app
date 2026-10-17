import { LockIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatTimestamp } from "@/lib/time";
import { requireSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import { listImports } from "@/server/imports/queries";
import { lockReason } from "../../_roster/lock-reason";
import { eventSectionHref } from "../../event-sections";
import { parseHistoryFilters } from "../history-filters";
import { ImportHistoryTable, type HistoryRow } from "../import-history-table";
import { ImportsTabs } from "../imports-tabs";

export default async function ImportHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const [{ id }, raw] = await Promise.all([params, searchParams]);
  const event = await getEvent(id);
  if (!event) notFound();

  const history = await listImports(event.id);
  const locked = lockReason(event, "upload or apply files");
  const rows: HistoryRow[] = history.map((item) => ({
    id: item.id,
    fileName: item.fileName,
    kind: item.kind,
    state: item.state,
    rows: item.rowCount,
    uploadedBy: item.createdByName ?? "Unknown",
    uploadedAt: item.createdAt.getTime(),
    uploadedLabel: formatTimestamp(item.createdAt, event.timezone),
  }));

  return (
    <>
      <PageHeader title="Imports" description="Every file uploaded to this event, newest first. Open one to see its report." />
      <div className="flex flex-col gap-5">
        <ImportsTabs eventId={event.id} active="history" historyCount={history.length} />
        {locked ? (
          <Alert>
            <LockIcon />
            <AlertTitle>Read-only</AlertTitle>
            <AlertDescription>{locked}</AlertDescription>
          </Alert>
        ) : null}
        <ImportHistoryTable
          eventId={event.id}
          rows={rows}
          lockedReason={locked}
          initialFilters={parseHistoryFilters(raw)}
          uploadHref={eventSectionHref(event.id, "imports")}
        />
      </div>
    </>
  );
}
