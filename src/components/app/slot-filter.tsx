"use client";

import * as React from "react";
import { cn } from "cn";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type SlotFilterProps = {
  slots: { slot: number; start: string }[];
  /** A slot number, or 0 for any slot. */
  value: number;
  onChange: (slot: number) => void;
  className?: string;
};

/** "Free in: any slot / Slot 1, 3:10 PM / …". Keeps people with no meeting in the chosen slot. */
export function SlotFilter({ slots, value, onChange, className }: SlotFilterProps) {
  const labelId = React.useId();
  const current = slots.find((s) => s.slot === value);
  return (
    <div className={cn("flex items-center gap-2 text-sm", className)}>
      <span id={labelId} className="text-muted-foreground">
        Free in
      </span>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger aria-labelledby={labelId} className="min-w-36 font-semibold tabular-nums">
          <SelectValue>{current ? `Slot ${current.slot}, ${current.start}` : "Any slot"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="0">Any slot</SelectItem>
            {slots.map((s) => (
              <SelectItem key={s.slot} value={String(s.slot)} className="tabular-nums">
                Slot {s.slot}, {s.start}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
