"use client";

import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { activityQuery, type SummaryStat } from "./activity-view";

const TILE =
  "flex min-w-0 flex-col items-start gap-0.5 rounded-lg border bg-card px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none";
const LINK_TILE = "hover:border-foreground/30 hover:bg-accent/50 aria-[current=true]:border-primary aria-[current=true]:ring-1 aria-[current=true]:ring-primary";

function Value({ stat }: { stat: SummaryStat }) {
  return (
    <>
      <span className="font-display text-2xl leading-none font-bold tabular-nums">{stat.value}</span>
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        {stat.label}
        {stat.choices ? <ChevronDownIcon className="size-3.5" aria-hidden="true" /> : null}
      </span>
    </>
  );
}

/** Today's numbers. Each one opens the log filtered to what it counts. */
export function ActivitySummaryStats({ basePath, stats }: { basePath: string; stats: SummaryStat[] }) {
  return (
    <ul aria-label="Today" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <li key={stat.key} className="flex min-w-0 flex-col">
          {stat.choices ? (
            <DropdownMenu>
              <DropdownMenuTrigger className={cn(TILE, LINK_TILE)} aria-current={stat.active || undefined}>
                <Value stat={stat} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{"Show today's changes by"}</DropdownMenuLabel>
                  {stat.choices.map((choice) => (
                    <DropdownMenuItem key={choice.filters.admin} asChild>
                      <Link href={`${basePath}${activityQuery(choice.filters)}`} scroll={false} aria-current={choice.active || undefined}>
                        {choice.label}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : stat.filters ? (
            <Link
              href={`${basePath}${activityQuery(stat.filters)}`}
              scroll={false}
              aria-current={stat.active || undefined}
              className={cn(TILE, LINK_TILE)}
            >
              <Value stat={stat} />
            </Link>
          ) : (
            <div className={TILE}>
              <Value stat={stat} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
