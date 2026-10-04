import { ChevronDownIcon, HistoryIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireSession } from "@/server/auth/session";
import { getActivityPage, parseActivityParams, type ActivityDetail, type ActivityParams } from "@/server/audit/queries";
import { ActivityFilters } from "./activity-filters";
import { UndoButton } from "./undo-button";

function pageHref(eventId: string, params: ActivityParams, page: number): string {
  const query = new URLSearchParams();
  for (const key of ["person", "admin", "type", "from", "to"] as const) {
    const value = params[key];
    if (value) query.set(key, value);
  }
  if (page > 1) query.set("page", String(page));
  const search = query.toString();
  return `/events/${eventId}/activity${search ? `?${search}` : ""}`;
}

function Details({ details }: { details: ActivityDetail[] }) {
  if (details.length === 0) return null;
  return (
    <Collapsible className="group/details">
      <CollapsibleTrigger asChild>
        <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground">
          Details
          <ChevronDownIcon data-icon="inline-end" className="transition-transform group-data-[state=open]/details:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-w-xl overflow-x-auto rounded-md border">
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Field</TableHead>
                <TableHead className="h-8">Before</TableHead>
                <TableHead className="h-8">After</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {details.map((d) => (
                <TableRow key={d.key} className="hover:bg-transparent">
                  <TableCell className="py-1.5 font-medium">{d.label}</TableCell>
                  <TableCell className="max-w-56 py-1.5 break-words whitespace-normal text-muted-foreground">{d.before ?? "–"}</TableCell>
                  <TableCell className="max-w-56 py-1.5 break-words whitespace-normal">{d.after ?? "–"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

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

  const { rows, total, page, pageSize } = activity;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(total, page * pageSize);
  const filtered = Boolean(filters.person || filters.admin || filters.type || filters.from || filters.to);

  return (
    <>
      <PageHeader
        title="Activity"
        description={`Every change to this event, newest first. Times are in ${activity.event.timezone.replace(/_/g, " ")}.`}
      />
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
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-44">When</TableHead>
                  <TableHead className="w-36">Who</TableHead>
                  <TableHead>What happened</TableHead>
                  <TableHead className="w-24 text-right">
                    <span className="sr-only">Undo</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className="align-top hover:bg-transparent">
                    <TableCell className="py-3 text-muted-foreground tabular-nums">{row.when}</TableCell>
                    <TableCell className="py-3">{row.who}</TableCell>
                    <TableCell className="py-3 whitespace-normal">
                      <div className="flex flex-col items-start gap-1">
                        <span>{row.sentence}</span>
                        {row.note ? <span className="text-sm text-muted-foreground">{row.note}</span> : null}
                        <Details details={row.details} />
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      {row.undo ? <UndoButton auditEventId={row.id} sentence={row.sentence} undo={row.undo} /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <nav aria-label="Activity pages" className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {firstShown}–{lastShown} of {total}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={pageHref(activity.event.id, filters, page - 1)}>Newer</Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Newer
                </Button>
              )}
              {page < lastPage ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={pageHref(activity.event.id, filters, page + 1)}>Older</Link>
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
