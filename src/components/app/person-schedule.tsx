import * as React from "react";
import { cn } from "cn";
import {
  MutualIcon,
  strengthLabel,
  TYPE_LABEL,
  treatmentClass,
  typeDotClass,
  type MatchStrength,
  type SupplierType,
} from "@/components/app/appointment-block";
import { RankBadge } from "@/components/app/rank-badge";

/**
 * One person's slots in order, with open slots shown. Server-safe: no hooks,
 * no client directive. Used by the schedule detail sheet (with ranks) and the
 * participant page (`showRanks={false}`, which must never show rankings).
 */

export type PersonScheduleSlot = {
  slot: number;
  start: string;
  end: string;
  appointment: {
    counterpartName: string;
    desk: number | null;
    buyerRank?: number | null;
    supplierRank?: number | null;
    strength?: MatchStrength;
    counterpartType?: SupplierType;
  } | null;
};

type PersonScheduleProps = {
  slots: PersonScheduleSlot[];
  personType: "buyer" | "supplier";
  showRanks?: boolean;
  compact?: boolean;
  className?: string;
  /** The event's mutualTopN, for rank highlights. Defaults to 10. */
  topN?: number;
  /** Supplier type of the person when `personType` is supplier; tones that side's rows. */
  personSupplierType?: SupplierType;
  /** Extra controls under a row, e.g. the editor's Replace, Remove, Pin. */
  renderActions?: (slot: PersonScheduleSlot) => React.ReactNode;
  /** Outlines this slot, e.g. the open slot that was clicked. */
  focusSlot?: number;
};

export function PersonSchedule({
  slots,
  personType,
  showRanks = false,
  compact = false,
  className,
  topN = 10,
  personSupplierType,
  renderActions,
  focusSlot,
}: PersonScheduleProps) {
  return (
    <ol
      data-slot="person-schedule"
      aria-label={`Schedule, ${slots.length} slots`}
      className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2", className)}
    >
      {slots.map((s) => {
        const a = s.appointment;
        const actions = renderActions?.(s);
        const focused = focusSlot === s.slot;
        // A supplier's rows take the supplier's own tone; a buyer's take each counterpart's.
        const tone = personType === "supplier" ? personSupplierType : a?.counterpartType;
        const treated = showRanks && a?.strength && tone;
        return (
          <li
            key={s.slot}
            data-slot-n={s.slot}
            className={cn("grid items-stretch gap-3", compact ? "grid-cols-[4rem_1fr]" : "grid-cols-[4.75rem_1fr]")}
          >
            <div className={cn("flex flex-col leading-tight", compact ? "pt-1.5" : "pt-2")}>
              <span className={cn("font-display font-bold tabular-nums", compact ? "text-sm" : "text-[15px]")}>{s.start}</span>
              <span className="text-xs text-muted-foreground tabular-nums">to {s.end}</span>
              {compact ? null : <span className="text-xs text-muted-foreground">Slot {s.slot}</span>}
            </div>
            <div
              className={cn(
                "flex min-w-0 flex-col gap-1 rounded-md",
                compact ? "min-h-11 px-2.5 py-1.5" : "min-h-14 px-3 py-2",
                a
                  ? treated
                    ? treatmentClass(tone, a.strength!)
                    : "border bg-card text-card-foreground"
                  : "border-[1.5px] border-dashed border-open text-muted-foreground",
                focused && "outline-2 outline-offset-2 outline-now",
              )}
            >
              {a ? (
                <>
                  <span className={cn("font-bold break-words", compact ? "text-sm leading-snug" : "text-[15px] leading-snug")}>
                    {a.counterpartName}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {a.desk != null ? <span className="font-semibold tabular-nums">Desk {a.desk}</span> : null}
                    {personType === "buyer" && a.counterpartType ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className={cn("size-2 rounded-[2px]", typeDotClass(a.counterpartType))} />
                        {TYPE_LABEL[a.counterpartType]}
                      </span>
                    ) : null}
                    {showRanks && a.strength ? (
                      <span className="inline-flex items-center gap-1 font-semibold">
                        {a.strength === "mutual" ? <MutualIcon /> : null}
                        {strengthLabel(a.strength, topN)}
                      </span>
                    ) : null}
                    {showRanks ? (
                      <span className="inline-flex items-center gap-1">
                        <RankBadge side="B" rank={a.buyerRank ?? null} topN={topN} />
                        <RankBadge side="S" rank={a.supplierRank ?? null} topN={topN} />
                      </span>
                    ) : null}
                  </span>
                </>
              ) : (
                <span className={cn("font-semibold text-foreground/80", compact ? "text-sm" : "text-[15px]")}>Open</span>
              )}
              {actions ? <div className="mt-1 flex flex-wrap items-center gap-1.5 text-foreground">{actions}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
