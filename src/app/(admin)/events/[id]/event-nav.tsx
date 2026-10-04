"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { EVENT_SECTIONS, eventSectionHref } from "./event-sections";

/** Secondary nav for one event. The active link is the one whose segment starts the current path. */
export function EventNav({ eventId }: { eventId: string }) {
  const pathname = usePathname();
  const base = `/events/${eventId}`;

  return (
    <nav aria-label="Event sections" className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
      <ul className="flex min-w-max items-stretch gap-1 border-b">
        {EVENT_SECTIONS.map((section) => {
          const href = eventSectionHref(eventId, section.segment);
          const active = section.segment
            ? pathname === href || pathname.startsWith(`${href}/`)
            : pathname === base;
          return (
            <li key={section.segment}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex h-9 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none",
                  "focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
