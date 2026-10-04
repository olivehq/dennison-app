"use client";

import * as React from "react";
import { PlusIcon } from "lucide-react";
import { cn } from "cn";
import {
  AppointmentBlock,
  MutualIcon,
  strengthLabel,
  treatmentClass,
  TYPE_LABEL,
  typeDotClass,
} from "@/components/app/appointment-block";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { ScheduleAppointment, ScheduleSlot } from "@/server/schedule/queries";
import { CountChip, healthInset } from "./count-chip";
import {
  appointmentsOf,
  healthOf,
  healthText,
  personLabel,
  personMatches,
  type Person,
  type ScheduleModel,
  type SupplierPerson,
  type Targets,
} from "./schedule-model";
import {
  changeovers,
  clockParts,
  finishedThrough,
  minuteAtFraction,
  minutesToPercent,
  rangeToPercent,
  stepNow,
  type TimelineSpan,
} from "./timeline-geometry";

type SlotGeom = ScheduleSlot & { left: number; width: number };

type TimelineProps = {
  mode: "supplier" | "buyer";
  lanes: Person[];
  totalLanes: number;
  model: ScheduleModel;
  slots: ScheduleSlot[];
  span: TimelineSpan;
  topN: number;
  targets: Targets;
  /** Normalised search text; blocks that do not match are dimmed in lanes that do not match themselves. */
  query: string;
  free: number;
  selectedId: string | null;
  focusSlot: number | null;
  liveSlot: number | null;
  editing: boolean;
  now: number;
  nowText: string;
  fade: boolean;
  playing: boolean;
  onNowChange: (minute: number) => void;
  onSelect: (personId: string, slot?: number) => void;
  onOpenSlot: (personId: string, slot: number) => void;
};

const HATCH =
  "bg-[repeating-linear-gradient(135deg,color-mix(in_oklch,var(--muted-foreground)_30%,transparent)_0_1px,transparent_1px_4px)]";

export function Timeline(props: TimelineProps) {
  const { mode, lanes, totalLanes, slots, span, free, now, nowText, fade, playing, onNowChange } = props;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const trackRef = React.useRef<HTMLDivElement>(null);
  const cornerRef = React.useRef<HTMLDivElement>(null);

  const geom = React.useMemo<SlotGeom[]>(
    () => slots.map((s) => ({ ...s, ...rangeToPercent(s.startMinutes, s.endMinutes, span) })),
    [slots, span],
  );
  const gaps = React.useMemo(
    () => changeovers(slots).map((g) => ({ ...g, ...rangeToPercent(g.start, g.end, span) })),
    [slots, span],
  );
  const nowPct = minutesToPercent(now, span);
  const done = fade ? finishedThrough(now, slots) : null;
  const donePct = done === null ? 0 : minutesToPercent(done, span);

  // Keep the now line on screen while playing, and bring it into view on first paint.
  const keepNowInView = React.useCallback((force: boolean) => {
    const scroller = scrollRef.current;
    const track = trackRef.current;
    const corner = cornerRef.current;
    if (!scroller || !track || !corner) return;
    const labelW = corner.offsetWidth;
    const x = labelW + (track.offsetWidth * nowPct) / 100;
    const left = scroller.scrollLeft + labelW;
    const right = scroller.scrollLeft + scroller.clientWidth;
    if (force || x < left + 20 || x > right - 40) {
      scroller.scrollLeft = Math.max(0, x - labelW - (scroller.clientWidth - labelW) * 0.3);
    }
  }, [nowPct]);

  React.useEffect(() => {
    if (playing) keepNowInView(false);
  }, [playing, keepNowInView]);

  const firstPaint = React.useRef(true);
  React.useEffect(() => {
    if (!firstPaint.current) return;
    firstPaint.current = false;
    if (nowPct > 0) keepNowInView(true);
  }, [keepNowInView, nowPct]);

  const dragging = React.useRef(false);
  const minuteFromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return now;
    return minuteAtFraction((clientX - rect.left) / rect.width, span);
  };

  return (
    <div
      ref={scrollRef}
      data-slot="scroll-area"
      className="relative max-h-[78dvh] overflow-auto overscroll-contain rounded-lg border bg-card [contain:inline-size] [--label-w:148px] [--ppm-min:9.5px] sm:[--label-w:220px] sm:[--ppm-min:10.5px] lg:max-h-[calc(100dvh-14rem)] xl:[--label-w:268px]"
      style={{ "--span": span.length } as React.CSSProperties}
    >
      <div className="relative min-w-[calc(var(--label-w)+var(--ppm-min)*var(--span))]">
        {/* Time axis */}
        <div className="sticky top-0 z-20 grid h-[52px] grid-cols-[var(--label-w)_1fr] border-b bg-card">
          <div
            ref={cornerRef}
            className="sticky left-0 z-30 flex flex-col justify-end overflow-hidden border-r bg-card px-2 pb-1.5 sm:px-3 sm:pb-2"
          >
            <span className="truncate font-display text-[13px] font-bold">
              {mode === "supplier" ? "Supplier desk" : "Buyer"}
            </span>
            <span className="truncate text-xs text-muted-foreground tabular-nums">
              {lanes.length === totalLanes ? `${totalLanes} lanes` : `${lanes.length} of ${totalLanes}`}
            </span>
          </div>
          <div
            ref={trackRef}
            className="relative cursor-ew-resize touch-none select-none"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              onNowChange(minuteFromPointer(e.clientX));
            }}
            onPointerMove={(e) => {
              if (dragging.current) onNowChange(minuteFromPointer(e.clientX));
            }}
            onPointerUp={() => (dragging.current = false)}
            onPointerCancel={() => (dragging.current = false)}
          >
            {geom.map((s) => (
              <div
                key={s.slot}
                className="absolute top-1.5 flex items-baseline gap-1.5 overflow-hidden px-1.5 whitespace-nowrap"
                style={{ left: `${s.left}%`, width: `${s.width}%` }}
              >
                <b className="font-display text-[15px] font-bold tabular-nums">{s.slot}</b>
                <span className="text-[11.5px] text-muted-foreground tabular-nums">{clockParts(s.startMinutes).time}</span>
              </div>
            ))}
            {gaps.map((g) => (
              <div
                key={g.start}
                className={cn("absolute top-[26px] bottom-0", HATCH)}
                style={{ left: `${g.left}%`, width: `${g.width}%` }}
                title={`Changeover ${clockParts(g.start).time} to ${clockParts(g.end).time}`}
              />
            ))}
            {Array.from({ length: span.length + 1 }, (_, m) => {
              const minute = span.start + m;
              const major = minute === span.end || slots.some((s) => s.startMinutes === minute);
              return (
                <div
                  key={m}
                  aria-hidden="true"
                  className={cn(
                    "absolute bottom-0 w-px",
                    major ? "h-3.5 bg-muted-foreground" : "h-[5px] bg-muted-foreground/45",
                  )}
                  style={{ left: `${minutesToPercent(minute, span)}%` }}
                />
              );
            })}
            <div
              role="slider"
              tabIndex={0}
              aria-label="Show clock"
              aria-valuemin={span.start}
              aria-valuemax={span.end}
              aria-valuenow={now}
              aria-valuetext={nowText}
              onKeyDown={(e) => {
                const next = stepNow(now, e.key, e.shiftKey, slots, span);
                if (next === null) return;
                e.preventDefault();
                onNowChange(next);
              }}
              className="absolute bottom-1 inline-flex h-[22px] cursor-grab items-center rounded-full bg-now px-2 text-xs font-bold whitespace-nowrap text-now-foreground tabular-nums outline-none after:absolute after:top-full after:left-1/2 after:-ml-px after:h-1 after:w-0.5 after:bg-now focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:cursor-grabbing"
              style={{
                left: `${nowPct}%`,
                // Keep the handle inside the track at the ends of the afternoon.
                transform: nowPct < 3 ? "translateX(-4px)" : nowPct > 97 ? "translateX(calc(-100% + 4px))" : "translateX(-50%)",
              }}
            >
              {clockParts(now).time}
            </div>
          </div>
        </div>

        {/* Lanes */}
        <div className="relative">
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 left-[var(--label-w)]">
            {geom.map((s) => (
              <div
                key={s.slot}
                className={cn(
                  "absolute inset-y-0",
                  s.slot % 2 === 0 && "bg-muted/55",
                  free === s.slot && "bg-ring/10 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--ring)_35%,transparent)]",
                )}
                style={{ left: `${s.left}%`, width: `${s.width}%` }}
              />
            ))}
            {gaps.map((g) => (
              <div key={g.start} className={cn("absolute inset-y-0", HATCH)} style={{ left: `${g.left}%`, width: `${g.width}%` }} />
            ))}
          </div>
          <Lanes
            mode={mode}
            lanes={lanes}
            model={props.model}
            geom={geom}
            topN={props.topN}
            targets={props.targets}
            query={props.query}
            selectedId={props.selectedId}
            focusSlot={props.focusSlot}
            liveSlot={props.liveSlot}
            editing={props.editing}
            onSelect={props.onSelect}
            onOpenSlot={props.onOpenSlot}
          />
          {donePct > 0 ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-[5] bg-card/60"
              style={{ left: "var(--label-w)", width: `calc((100% - var(--label-w)) * ${donePct / 100})` }}
            />
          ) : null}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 z-[6] -ml-px w-0.5 bg-now"
            style={{ left: `calc(var(--label-w) + (100% - var(--label-w)) * ${nowPct / 100})` }}
          />
        </div>
      </div>
    </div>
  );
}

type LanesProps = {
  mode: "supplier" | "buyer";
  lanes: Person[];
  model: ScheduleModel;
  geom: SlotGeom[];
  topN: number;
  targets: Targets;
  query: string;
  selectedId: string | null;
  focusSlot: number | null;
  liveSlot: number | null;
  editing: boolean;
  onSelect: (personId: string, slot?: number) => void;
  onOpenSlot: (personId: string, slot: number) => void;
};

/** The lane rows. Memoised so the moving now line does not re-render 500 blocks every minute. */
const Lanes = React.memo(function Lanes({
  mode,
  lanes,
  model,
  geom,
  topN,
  targets,
  query,
  selectedId,
  focusSlot,
  liveSlot,
  editing,
  onSelect,
  onOpenSlot,
}: LanesProps) {
  return (
    <>
      {lanes.map((p) => {
        const health = healthOf(p, targets);
        const label = personLabel(p);
        const mine = appointmentsOf(model, p.id);
        const laneHit = query !== "" && personMatches(p, query);
        const laneName = p.kind === "supplier" ? `Desk ${p.desk ?? "not set"}, ${p.name}` : p.name;
        return (
          <div
            key={p.id}
            role="group"
            aria-label={laneName}
            className="grid h-[50px] grid-cols-[var(--label-w)_1fr] border-b border-border/75"
          >
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              aria-label={`${laneName}${p.kind === "supplier" ? `, ${TYPE_LABEL[p.type]}` : ""}. ${healthText(p, targets)}. Open schedule`}
              aria-pressed={selectedId === p.id}
              className={cn(
                "sticky left-0 z-10 flex min-w-0 items-center gap-1.5 border-r bg-card pr-1.5 pl-2 text-left outline-none hover:bg-accent focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:gap-2.5 sm:pr-2.5 sm:pl-3",
                healthInset(health),
                selectedId === p.id && "bg-accent",
              )}
            >
              {p.kind === "supplier" ? (
                <span className="inline-grid h-5 min-w-[22px] shrink-0 place-items-center rounded-sm bg-secondary px-1 font-display text-xs font-bold text-secondary-foreground tabular-nums sm:h-6 sm:min-w-7 sm:text-[13px]">
                  {p.desk ?? "–"}
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-xs leading-tight font-semibold sm:block sm:truncate sm:text-[13.5px]">
                  {label.primary}
                </span>
                {p.kind === "supplier" ? (
                  <span className="mt-0.5 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                    <span aria-hidden="true" className={cn("size-2 rounded-[2px]", typeDotClass(p.type))} />
                    {TYPE_LABEL[p.type]}
                    {p.withdrawn ? ", withdrawn" : null}
                  </span>
                ) : label.secondary || p.withdrawn ? (
                  <span className="mt-0.5 hidden truncate text-xs text-muted-foreground sm:block">
                    {[label.secondary, p.withdrawn ? "Withdrawn" : null].filter(Boolean).join(", ")}
                  </span>
                ) : null}
              </span>
              <CountChip count={p.count} health={health} />
            </button>
            <div className="relative">
              {geom.map((s) => {
                const a = mine.get(s.slot);
                const style = { left: `${s.left}%`, width: `${s.width}%` };
                if (!a) {
                  const openLabel = `Open slot ${s.slot}, ${s.start} to ${s.end}, for ${label.primary}`;
                  return editing ? (
                    <button
                      key={s.slot}
                      type="button"
                      onClick={() => onOpenSlot(p.id, s.slot)}
                      aria-label={`${openLabel}. Fill it`}
                      className="absolute inset-y-[5px] flex items-center justify-center gap-1 rounded-[3px] border-[1.5px] border-dashed border-open bg-card/60 text-[11.5px] font-semibold text-muted-foreground outline-none hover:border-foreground hover:bg-card hover:text-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      style={style}
                    >
                      <PlusIcon aria-hidden="true" className="size-3" />
                      <span className="max-sm:sr-only">Open</span>
                    </button>
                  ) : (
                    <div
                      key={s.slot}
                      role="img"
                      aria-label={openLabel}
                      className="absolute inset-y-[5px] flex items-center justify-center rounded-[3px] border-[1.5px] border-dashed border-open text-[11.5px] font-semibold text-muted-foreground"
                      style={style}
                    >
                      <span className="max-sm:sr-only">Open</span>
                    </div>
                  );
                }
                return (
                  <TimelineBlock
                    key={s.slot}
                    appointment={a}
                    slot={s}
                    style={style}
                    mode={mode}
                    model={model}
                    topN={topN}
                    selected={selectedId === p.id && focusSlot === s.slot}
                    live={liveSlot === s.slot}
                    dim={query !== "" && !laneHit ? !counterpartMatches(model, a, mode, query) : false}
                    hit={query !== "" && !laneHit && counterpartMatches(model, a, mode, query)}
                    onClick={() => onSelect(p.id, s.slot)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
});

function counterpartMatches(model: ScheduleModel, a: ScheduleAppointment, mode: "supplier" | "buyer", q: string): boolean {
  const other = model.personById.get(mode === "supplier" ? a.buyerId : a.supplierId);
  return other ? personMatches(other, q) : false;
}

function TimelineBlock({
  appointment: a,
  slot,
  style,
  mode,
  model,
  topN,
  selected,
  live,
  dim,
  hit,
  onClick,
}: {
  appointment: ScheduleAppointment;
  slot: ScheduleSlot;
  style: React.CSSProperties;
  mode: "supplier" | "buyer";
  model: ScheduleModel;
  topN: number;
  selected: boolean;
  live: boolean;
  dim: boolean;
  hit: boolean;
  onClick: () => void;
}) {
  const supplier = model.personById.get(a.supplierId) as SupplierPerson | undefined;
  const buyer = model.personById.get(a.buyerId);
  if (!supplier || !buyer) return null;
  const buyerLabel = personLabel(buyer);
  return (
    <HoverCard openDelay={280} closeDelay={60}>
      <HoverCardTrigger asChild>
        <AppointmentBlock
          appointment={a}
          supplierName={supplier.name}
          buyerName={buyerLabel.primary}
          supplierType={supplier.type}
          desk={supplier.desk}
          mutualTopN={topN}
          laneType={mode}
          selected={selected}
          timeLabel={`${slot.start} to ${slot.end}`}
          onClick={onClick}
          style={style}
          title={a.counterpartWithdrawn ? "Someone in this meeting withdrew. Replace or remove it before locking." : undefined}
          data-withdrawn={a.counterpartWithdrawn || undefined}
          className={cn(
            live && !selected && "outline-2 outline-offset-1 outline-now",
            dim && "opacity-25",
            hit && "outline-2 outline-offset-1 outline-foreground",
            a.counterpartWithdrawn && "border-l-4 border-l-destructive",
          )}
        />
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
          <span>
            Slot {a.slot}, {slot.start} to {slot.end}
          </span>
          <span>{supplier.desk === null ? "No desk yet" : `Desk ${supplier.desk}`}</span>
        </div>
        <p className="mt-1.5 leading-snug font-semibold">{supplier.name}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true" className={cn("size-2 rounded-[2px]", typeDotClass(supplier.type))} />
          {TYPE_LABEL[supplier.type]}
        </p>
        <p className="mt-1.5 leading-snug">{buyerLabel.primary}</p>
        {buyerLabel.secondary ? <p className="text-xs text-muted-foreground">{buyerLabel.secondary}</p> : null}
        <div className="mt-2.5 grid grid-cols-3 gap-2 border-t pt-2.5 text-xs">
          <div>
            <p className="text-muted-foreground">Buyer rank</p>
            <p className="text-base font-bold tabular-nums">{a.buyerRank ?? "–"}</p>
            <p className="text-muted-foreground">{a.buyerRank === null ? "Left blank" : "of the supplier"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Supplier rank</p>
            <p className="text-base font-bold tabular-nums">{a.supplierRank ?? "–"}</p>
            <p className="text-muted-foreground">{a.supplierRank === null ? "Left blank" : "of the buyer"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Match</p>
            <p className="mt-1 flex items-center gap-1.5 font-semibold">
              <span aria-hidden="true" className={cn("h-3 w-3.5 shrink-0 rounded-[2px]", treatmentClass(supplier.type, a.strength))} />
              {a.strength === "mutual" ? <MutualIcon /> : null}
            </p>
            <p className="text-muted-foreground">{strengthLabel(a.strength, topN)}</p>
          </div>
        </div>
        {a.counterpartWithdrawn ? (
          <p className="mt-2 border-t pt-2 text-xs font-semibold text-destructive">
            {[supplier.withdrawn ? supplier.name : null, buyer.withdrawn ? buyerLabel.primary : null].filter(Boolean).join(" and ")} withdrew.
            Replace or remove this meeting before locking.
          </p>
        ) : null}
        {a.pinned || a.source === "manual" ? (
          <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
            {[a.pinned ? "Pinned, kept by the next re-run" : null, a.source === "manual" ? "Placed by hand" : null]
              .filter(Boolean)
              .join(". ")}
          </p>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
