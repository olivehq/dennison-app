"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import type { EventStatus } from "@/lib/schemas/event";
import { EventStatusBadge } from "../event-status-badge";
import { eventSectionHref, sectionForPath } from "./event-sections";

type EventHeaderProps = {
  event: { id: string; name: string; status: EventStatus };
  /** "Nov 14, 2025, America/Los Angeles": the date and timezone line every event page keeps. */
  when: string;
};

/**
 * The line above each event page's own title: "Event name / Section", with
 * the date, timezone, and status on the right. The overview has no title of
 * its own, so there the event name is the page title.
 */
export function EventHeader({ event, when }: EventHeaderProps) {
  const pathname = usePathname();
  const section = sectionForPath(pathname, event.id);
  const overviewHref = eventSectionHref(event.id, "");

  if (section?.segment === "") {
    return (
      <header className="mb-4 flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="font-display text-[22px] leading-tight font-bold tracking-[-0.01em] text-balance sm:text-[26px]">
            {event.name}
          </h1>
          <EventStatusBadge status={event.status} />
        </div>
        <p className="text-sm text-muted-foreground">{when}</p>
      </header>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="gap-1.5 text-xs sm:gap-1.5">
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbLink asChild className="truncate">
              <Link href={overviewHref}>{event.name}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {section ? (
            <>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                {section.nested ? (
                  <BreadcrumbLink asChild>
                    <Link href={eventSectionHref(event.id, section.segment)}>{section.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="text-muted-foreground">{section.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {when}
        <EventStatusBadge status={event.status} />
      </p>
    </div>
  );
}
