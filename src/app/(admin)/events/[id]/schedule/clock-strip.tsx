"use client";

import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import type { ScheduleSlot } from "@/server/schedule/queries";
import { clockParts, type NowPhase } from "./timeline-geometry";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type ClockCounts = {
  desksBusy: number;
  desks: number;
  buyersBusy: number;
  buyers: number;
  /** Buyers with a meeting in the next slot, for the changeover line. */
  movingNext: number;
  appointments: number;
};

/** The headline and the line under it for the show clock. */
export function clockLines(phase: NowPhase, slotCount: number, counts: ClockCounts): { line1: string; line2: string } {
  switch (phase.phase) {
    case "in": {
      const { slot, minutesIn, minutesLeft } = phase;
      return {
        line1: `Slot ${slot.slot} of ${slotCount}, ${minutesIn === 0 ? "just starting" : `${plural(minutesIn, "minute")} in`}, ${plural(minutesLeft, "minute")} to go`,
        line2: `${counts.desksBusy} of ${counts.desks} desks in a meeting. ${counts.buyersBusy} of ${counts.buyers} buyers busy.`,
      };
    }
    case "gap":
      return {
        line1: `Changeover. Slot ${phase.next.slot} starts at ${clockParts(phase.next.startMinutes).time}`,
        line2: `${plural(counts.movingNext, "buyer")} heading to their next desk.`,
      };
    case "after":
      return { line1: "The afternoon is over", line2: `${counts.appointments} appointments across ${slotCount} slots.` };
    case "before":
      return { line1: `Doors open at ${clockParts(phase.next.startMinutes).time}`, line2: "" };
  }
}

type ClockStripProps = {
  now: number;
  phase: NowPhase;
  slots: ScheduleSlot[];
  counts: ClockCounts;
  live: boolean;
  playing: boolean;
  fade: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPlay: () => void;
  onFade: (fade: boolean) => void;
  onShowFree: (slot: number) => void;
};

export function ClockStrip({ now, phase, slots, counts, live, playing, fade, onPrev, onNext, onPlay, onFade, onShowFree }: ClockStripProps) {
  const { time, meridiem } = clockParts(now);
  const { line1, line2 } = clockLines(phase, slots.length, counts);
  const freeBuyers = counts.buyers - counts.buyersBusy;
  return (
    <section aria-label="Show clock" className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex items-baseline gap-2" aria-live="off">
        <span className="font-display text-[34px] leading-none font-extrabold tracking-[-0.03em] tabular-nums sm:text-[44px]">
          {time}
        </span>
        <span className="font-display text-lg font-bold text-muted-foreground">{meridiem}</span>
        {live ? <span className="sr-only">Live time</span> : null}
      </div>
      <div className="min-w-0 flex-1 basis-72">
        <p className="font-display text-[17px] leading-snug font-semibold">{line1}</p>
        {line2 || phase.phase === "in" ? (
          <p className="text-sm text-muted-foreground">
            {line2}{" "}
            {phase.phase === "in" ? (
              freeBuyers > 0 ? (
                <Button
                  variant="link"
                  className="h-auto p-0 font-semibold text-foreground underline underline-offset-4"
                  onClick={() => onShowFree(phase.slot.slot)}
                >
                  {plural(freeBuyers, "buyer")} free
                </Button>
              ) : (
                "None free."
              )
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="icon-lg" aria-label="Previous slot" onClick={onPrev}>
          <SkipBackIcon />
        </Button>
        <Button
          size="lg"
          aria-pressed={playing}
          onClick={onPlay}
          className="bg-now px-3.5 font-bold text-now-foreground hover:bg-now/90"
        >
          {playing ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          {playing ? "Pause" : "Play afternoon"}
        </Button>
        <Button variant="outline" size="icon-lg" aria-label="Next slot" onClick={onNext}>
          <SkipForwardIcon />
        </Button>
        <Toggle variant="outline" size="lg" pressed={fade} onPressedChange={onFade} className="ml-1">
          Fade finished
        </Toggle>
      </div>
    </section>
  );
}
