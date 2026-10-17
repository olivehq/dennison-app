"use client";

import * as React from "react";
import { KeyRoundIcon, PencilLine, Pin, UserX } from "lucide-react";
import { cn } from "cn";
import {
  MutualIcon,
  NEEDS_FILLING_CLASS,
  treatmentClass,
  typeDotClass,
  WITHDRAWN_CLASS,
} from "@/components/app/appointment-block";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const SWATCH = "inline-block h-3.5 w-[26px] shrink-0 rounded-[2px] p-0";

function KeyGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-xs font-semibold text-foreground">
        {title}
      </h2>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

function KeyItem({ mark, children }: { mark: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden="true" className="flex h-[18px] w-[26px] shrink-0 items-center justify-center">
        {mark}
      </span>
      <span>{children}</span>
    </li>
  );
}

/** "Key": how to read the blocks, grouped, in a popover beside the filters. */
export function Legend({ topN, className }: { topN: number; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className={className}>
          <KeyRoundIcon data-icon="inline-start" />
          Key
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Key"
        // Always below the button: on a phone a flipped popover covers the toolbar and starts off screen.
        // It scrolls inside the room left under the button instead.
        avoidCollisions={false}
        collisionPadding={16}
        className="max-h-(--radix-popover-content-available-height) w-[min(36rem,calc(100vw-2rem))] gap-4 overflow-y-auto p-4 text-[13px] text-muted-foreground"
      >
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <KeyGroup title="Who wanted the meeting">
            <KeyItem mark={<span className={cn(SWATCH, treatmentClass("hotel", "mutual"))} />}>
              <span className="inline-flex items-center gap-1">
                <MutualIcon className="size-3.5" /> Both ranked each other top {topN}
              </span>
            </KeyItem>
            <KeyItem mark={<span className={cn(SWATCH, treatmentClass("hotel", "buyer"))} />}>
              One side top {topN}, bar on the side that ranked
            </KeyItem>
            <KeyItem mark={<span className={cn(SWATCH, treatmentClass("hotel", "neither"))} />}>Neither</KeyItem>
            <KeyItem mark={<span className={cn(SWATCH, treatmentClass("hotel", "blank"))} />}>A rank left blank</KeyItem>
          </KeyGroup>
          <KeyGroup title="Needs attention">
            <KeyItem mark={<span className={cn(SWATCH, NEEDS_FILLING_CLASS)} />}>
              Needs filling, the person is below target
            </KeyItem>
            <KeyItem
              mark={
                <span className={cn(SWATCH, WITHDRAWN_CLASS, "inline-grid place-items-center")}>
                  <UserX className="size-3" />
                </span>
              }
            >
              Withdrawn, replace or remove before locking. A red name means this person withdrew
            </KeyItem>
            <KeyItem
              mark={
                <span className="inline-flex h-3.5 gap-0.5">
                  <span className="w-[3px] rounded-[1px] bg-destructive" />
                  <span className="w-[3px] rounded-[1px] bg-warning" />
                </span>
              }
            >
              Edge on a name: below or above the target
            </KeyItem>
          </KeyGroup>
          <KeyGroup title="Markers">
            <KeyItem mark={<span className={cn(SWATCH, "border-[1.5px] border-dashed border-open")} />}>Open slot</KeyItem>
            <KeyItem mark={<Pin className="size-3.5 text-foreground" />}>Pinned, marked as reviewed</KeyItem>
            <KeyItem mark={<PencilLine className="size-3.5 text-foreground" />}>Placed by hand</KeyItem>
            <KeyItem
              mark={
                <span
                  className={cn(
                    SWATCH,
                    "bg-[repeating-linear-gradient(135deg,color-mix(in_oklch,var(--muted-foreground)_35%,transparent)_0_1px,transparent_1px_4px)]",
                  )}
                />
              }
            >
              1-minute changeover
            </KeyItem>
          </KeyGroup>
          <KeyGroup title="Supplier type">
            <KeyItem mark={<span className={cn("size-2 rounded-[2px]", typeDotClass("hotel"))} />}>
              Hotel or destination
            </KeyItem>
            <KeyItem mark={<span className={cn("size-2 rounded-[2px]", typeDotClass("business"))} />}>
              Business vendor
            </KeyItem>
          </KeyGroup>
        </div>
        <p className="border-t pt-3">
          B is the buyer&apos;s rank of the supplier, S is the supplier&apos;s rank of the buyer, a dash means left blank.
          In buyer lanes the boxed number is the desk.
        </p>
      </PopoverContent>
    </Popover>
  );
}
