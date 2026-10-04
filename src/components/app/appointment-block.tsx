import * as React from "react";
import { ArrowLeftRight, PencilLine, Pin } from "lucide-react";
import { cn } from "cn";
import { RankBadge } from "@/components/app/rank-badge";

/**
 * The timeline block from the 03 Resource timeline design. Supplier type sets
 * the tone (hotel teal, business marigold). Match strength is treatment, not
 * colour: mutual is a solid fill, one side is a tint with a solid edge bar on
 * the side that ranked top N (buyer left, supplier right, the same order as
 * the rank badges), neither is an outline, blank is a dashed outline.
 */

export type MatchStrength = "mutual" | "buyer" | "supplier" | "neither" | "blank";
export type SupplierType = "business" | "hotel";

const TONES = {
  hotel: {
    solid: "bg-hotel text-hotel-foreground",
    tint: "bg-hotel-tint text-hotel-ink",
    outline: "bg-card text-hotel-ink border-hotel",
    barStart: "shadow-[inset_4px_0_0_var(--color-hotel)]",
    barEnd: "shadow-[inset_-4px_0_0_var(--color-hotel)]",
    dot: "bg-hotel",
  },
  business: {
    solid: "bg-business text-business-foreground",
    tint: "bg-business-tint text-business-ink",
    outline: "bg-card text-business-ink border-business",
    barStart: "shadow-[inset_4px_0_0_var(--color-business)]",
    barEnd: "shadow-[inset_-4px_0_0_var(--color-business)]",
    dot: "bg-business",
  },
} as const;

/** Classes for a surface drawn with a match treatment. Shared by the block, the sheet rows, and the legend. */
export function treatmentClass(type: SupplierType, strength: MatchStrength): string {
  const t = TONES[type];
  switch (strength) {
    case "mutual":
      return t.solid;
    case "buyer":
      return cn(t.tint, t.barStart, "pl-2.5");
    case "supplier":
      return cn(t.tint, t.barEnd, "pr-2.5");
    case "neither":
      return cn(t.outline, "border-[1.5px]");
    case "blank":
      return cn(t.outline, "border-[1.5px] border-dashed");
  }
}

export function typeDotClass(type: SupplierType): string {
  return TONES[type].dot;
}

export const TYPE_LABEL: Record<SupplierType, string> = { hotel: "Hotel", business: "Business" };

export function strengthLabel(strength: MatchStrength, topN: number): string {
  switch (strength) {
    case "mutual":
      return `Mutual top ${topN}`;
    case "buyer":
      return `Buyer's top ${topN}`;
    case "supplier":
      return `Supplier's top ${topN}`;
    case "neither":
      return `Neither top ${topN}`;
    case "blank":
      return "A rank was left blank";
  }
}

export function MutualIcon({ className }: { className?: string }) {
  return <ArrowLeftRight aria-hidden="true" className={cn("size-3 shrink-0", className)} />;
}

export type AppointmentBlockData = {
  id: string;
  slot: number;
  buyerRank: number | null;
  supplierRank: number | null;
  source: "engine" | "manual";
  pinned: boolean;
  strength: MatchStrength;
};

type AppointmentBlockProps = Omit<React.ComponentProps<"button">, "children"> & {
  appointment: AppointmentBlockData;
  supplierName: string;
  buyerName: string;
  supplierType: SupplierType;
  /** The supplier's desk, shown as a boxed number in buyer lanes. */
  desk?: number | null;
  mutualTopN: number;
  /** Which lane the block sits in: a supplier lane shows the buyer, a buyer lane shows the supplier. */
  laneType: "supplier" | "buyer";
  selected?: boolean;
  /** Slot time range for the accessible label, e.g. "3:10 to 3:20 PM". */
  timeLabel?: string;
};

/** Absolutely positioned by the parent through `style` (left and width from minutes). */
export function AppointmentBlock({
  appointment: a,
  supplierName,
  buyerName,
  supplierType,
  desk,
  mutualTopN,
  laneType,
  selected = false,
  timeLabel,
  className,
  ...props
}: AppointmentBlockProps) {
  const name = laneType === "supplier" ? buyerName : supplierName;
  const label = [
    `${supplierName}${desk != null ? `, desk ${desk}` : ""}, with ${buyerName}`,
    `Slot ${a.slot}${timeLabel ? `, ${timeLabel}` : ""}`,
    `Buyer rank ${a.buyerRank ?? "blank"}, supplier rank ${a.supplierRank ?? "blank"}`,
    strengthLabel(a.strength, mutualTopN),
    TYPE_LABEL[supplierType],
    a.pinned ? "Pinned" : null,
    a.source === "manual" ? "Placed by hand" : null,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <button
      type="button"
      data-slot="appointment-block"
      data-strength={a.strength}
      data-selected={selected || undefined}
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        "absolute inset-y-[5px] flex min-w-0 flex-col justify-center gap-0.5 overflow-hidden rounded-[3px] px-1.5 text-left text-[11.5px] leading-tight transition-[opacity,filter] hover:brightness-[0.97] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
        treatmentClass(supplierType, a.strength),
        selected && "outline-2 outline-offset-1 outline-foreground",
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-bold">{name}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
        {a.strength === "mutual" ? <MutualIcon /> : null}
        {laneType === "buyer" && desk != null ? (
          <span className="rounded-[2px] px-0.5 font-bold tabular-nums ring-1 ring-current ring-inset" title={`Desk ${desk}`}>
            {desk}
          </span>
        ) : null}
        <RankBadge side="B" rank={a.buyerRank} topN={mutualTopN} className="h-4 px-0.5 text-[11px]" />
        <RankBadge side="S" rank={a.supplierRank} topN={mutualTopN} className="h-4 px-0.5 text-[11px]" />
        {a.pinned ? <Pin aria-hidden="true" className="size-3 shrink-0" /> : null}
        {a.source === "manual" ? <PencilLine aria-hidden="true" className="size-3 shrink-0" /> : null}
      </span>
    </button>
  );
}
