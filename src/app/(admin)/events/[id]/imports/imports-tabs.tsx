import { cn } from "cn";
import Link from "next/link";
import { eventSectionHref } from "../event-sections";

export function importsHistoryHref(eventId: string): string {
  return `${eventSectionHref(eventId, "imports")}/history`;
}

/** Upload and History, the two Imports pages. Links, not tab panels: each is its own URL. */
export function ImportsTabs({ eventId, active, historyCount }: { eventId: string; active: "upload" | "history"; historyCount: number }) {
  const tabs = [
    { key: "upload", label: "Upload", href: eventSectionHref(eventId, "imports"), count: null },
    { key: "history", label: "History", href: importsHistoryHref(eventId), count: historyCount },
  ] as const;
  return (
    <nav aria-label="Imports">
      <ul className="flex items-stretch gap-1 border-b">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={tab.key === active ? "page" : undefined}
              className={cn(
                "-mb-px flex h-9 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none motion-reduce:transition-none",
                "focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50",
                tab.key === active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count !== null ? <span className="text-muted-foreground tabular-nums">{tab.count}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
