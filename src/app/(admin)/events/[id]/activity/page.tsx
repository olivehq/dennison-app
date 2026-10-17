import { HistoryIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { requireSession } from "@/server/auth/session";
import { getActivityPage, parseActivityParams } from "@/server/audit/queries";
import { ActivityFilters } from "./activity-filters";
import { ActivitySummaryStats } from "./activity-summary";
import { ActivityTimeline } from "./activity-timeline";
import { activityQuery, groupByDay, isFiltered, summaryStats } from "./activity-view";

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const [{ id }, raw] = await Promise.all([params, searchParams]);
  const filters = parseActivityParams(raw);
  const activity = await getActivityPage(id, filters);
  if (!activity) notFound();

  const { rows, total, page, pageSize, summary, event } = activity;
  const basePath = `/events/${event.id}/activity`;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(total, page * pageSize);
  const filtered = isFiltered(filters);

  return (
    <>
      <PageHeader
        title="Activity"
        description={`Every change to this event, newest first. Times are in ${event.timezone.replace(/_/g, " ")}.`}
      />
      <ActivitySummaryStats basePath={basePath} stats={summaryStats(summary, filters)} />
      <ActivityFilters params={filters} people={activity.people} admins={activity.admins} />
      {rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HistoryIcon />
            </EmptyMedia>
            <EmptyTitle>{filtered ? "No changes match these filters" : "No changes yet"}</EmptyTitle>
            <EmptyDescription>
              {filtered ? "Clear a filter or widen the dates." : "Imports, matching runs, and schedule edits will show here."}
            </EmptyDescription>
          </EmptyHeader>
          {filtered ? (
            <EmptyContent>
              <Button variant="outline" size="sm" asChild>
                <Link href={basePath} scroll={false}>
                  Clear filters
                </Link>
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <ActivityTimeline groups={groupByDay(rows, summary, event.timezone)} />
          <nav aria-label="Activity pages" className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {firstShown}–{lastShown} of {total}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`${basePath}${activityQuery(filters, page - 1)}`}>Newer</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Newer
                </Button>
              )}
              {page < lastPage ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`${basePath}${activityQuery(filters, page + 1)}`}>Older</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Older
                </Button>
              )}
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
