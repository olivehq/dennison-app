"use client";

import { ChevronDownIcon } from "lucide-react";
import { cn } from "cn";
import { MutualIcon, treatmentClass, typeDotClass } from "@/components/app/appointment-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";

const SWATCH = "inline-block h-3.5 w-[26px] shrink-0 rounded-[2px] p-0";

/** How to read the blocks. Collapsed behind a trigger on phones, always open from sm up. */
export function Legend({ topN }: { topN: number }) {
  return (
    <Collapsible className="group/legend">
      <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-sm text-sm font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:hidden">
        How to read the blocks
        <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform group-data-[state=open]/legend:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent
        forceMount
        aria-label="Legend"
        className="flex-wrap items-center gap-x-5 gap-y-2 pt-2 text-[13px] text-muted-foreground data-[state=closed]:hidden data-[state=open]:flex sm:pt-0 sm:data-[state=closed]:flex"
      >
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className={cn("size-2 rounded-[2px]", typeDotClass("hotel"))} />
          Hotel or destination
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className={cn("size-2 rounded-[2px]", typeDotClass("business"))} />
          Business vendor
        </span>
        <Separator orientation="vertical" className="h-4 max-sm:hidden" />
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className={cn(SWATCH, treatmentClass("hotel", "mutual"))} />
          <MutualIcon className="size-3.5" /> Both ranked each other top {topN}
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className={cn(SWATCH, treatmentClass("hotel", "buyer"))} />
          One side top {topN}, bar on the side that ranked
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className={cn(SWATCH, treatmentClass("hotel", "neither"))} />
          Neither
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className={cn(SWATCH, treatmentClass("hotel", "blank"))} />
          A rank left blank
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className={cn(SWATCH, "border-[1.5px] border-dashed border-open")} />
          Open slot
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              SWATCH,
              "bg-[repeating-linear-gradient(135deg,color-mix(in_oklch,var(--muted-foreground)_35%,transparent)_0_1px,transparent_1px_4px)]",
            )}
          />
          1-minute changeover
        </span>
        <span>
          B is the buyer&apos;s rank of the supplier, S is the supplier&apos;s rank of the buyer, a dash means left blank. In
          buyer lanes the boxed number is the desk.
        </span>
      </CollapsibleContent>
    </Collapsible>
  );
}
