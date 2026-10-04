"use client";

import * as React from "react";
import {
  AlertTriangleIcon,
  DownloadIcon,
  LockIcon,
  LockOpenIcon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { SlotFilter } from "@/components/app/slot-filter";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nowInTimezone } from "@/lib/time";
import { eventSectionHref } from "../event-sections";
import { ClockStrip } from "./clock-strip";
import { CommandMenu } from "./command-menu";
import { Legend } from "./legend";
import { LockDialog, UnlockDialog } from "./lock-dialogs";
import { PersonSheet } from "./person-sheet";
import { QualityView } from "./quality-view";
import {
  attentionCount,
  buildModel,
  busyCount,
  healthOf,
  isLockedStatus,
  lanesFor,
  normalizeQuery,
  parseFree,
  parseView,
  VIEWS,
  type ViewId,
  type WorkspaceData,
} from "./schedule-model";
import { SlotBoard } from "./slot-board";
import type { PickerRequest } from "./swap-picker";
import {
  clockParts,
  focusSlotAt,
  initialNow,
  nextSlotStart,
  phaseAt,
  playStep,
  prevSlotStart,
  slotAtMinute,
  timelineSpan,
} from "./timeline-geometry";
import { Timeline } from "./timeline";

type Params = Partial<Record<"view" | "q" | "free" | "sel", string | null>>;

/**
 * View, search, free-in-slot, and the selected person live in the URL so a
 * link reproduces the screen and Back works. Written with the History API,
 * which Next.js syncs into useSearchParams without a server round trip.
 */
function writeParams(patch: Params, mode: "push" | "replace" = "push") {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "" || value === "0") params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

const subscribeNothing = () => () => {};

function useIsMac(): boolean {
  return React.useSyncExternalStore(
    subscribeNothing,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => false,
  );
}

export function ScheduleWorkspace({ data, serverNow }: { data: WorkspaceData; serverNow: { today: string; minutes: number } }) {
  const { eventId, slots, settings, run } = data;
  const targets = settings;
  const topN = settings.mutualTopN;
  const locked = isLockedStatus(data.status);
  const canUnlock = data.status === "locked" || data.status === "sent";

  // URL state
  const searchParams = useSearchParams();
  const view = parseView(searchParams.get("view"));
  const free = parseFree(searchParams.get("free"), slots);
  const sel = searchParams.get("sel");
  const qParam = searchParams.get("q") ?? "";
  const [q, setQ] = React.useState(qParam);
  const [seenQParam, setSeenQParam] = React.useState(qParam);
  if (qParam !== seenQParam) {
    // Back and forward change the URL under us; follow it.
    setSeenQParam(qParam);
    setQ(qParam);
  }
  const query = normalizeQuery(q);

  // Local state
  const [flagged, setFlagged] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const editingOn = editing && !locked;
  const [focusSlot, setFocusSlot] = React.useState<number | null>(null);
  const [picker, setPicker] = React.useState<PickerRequest | null>(null);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [lockOpen, setLockOpen] = React.useState(false);
  const [unlockOpen, setUnlockOpen] = React.useState(false);
  const [slotPick, setSlotPick] = React.useState(0);
  const [seenVersion, setSeenVersion] = React.useState({ runId: run.id, version: run.version });
  const version = seenVersion.runId === run.id ? Math.max(seenVersion.version, run.version) : run.version;
  const onVersion = React.useCallback((v: number) => setSeenVersion({ runId: run.id, version: v }), [run.id]);

  const model = React.useMemo(
    () => buildModel({ suppliers: data.suppliers, buyers: data.buyers, appointments: data.appointments }),
    [data.suppliers, data.buyers, data.appointments],
  );
  const span = React.useMemo(() => timelineSpan(slots), [slots]);

  // The show clock
  const [clock, setClock] = React.useState(() =>
    initialNow({ eventDate: data.eventDate, today: serverNow.today, liveMinutes: serverNow.minutes, span }),
  );
  const [playing, setPlaying] = React.useState(false);
  const [fade, setFade] = React.useState(true);
  const minuteRef = React.useRef(clock.minute);
  React.useEffect(() => {
    minuteRef.current = clock.minute;
  }, [clock.minute]);

  React.useEffect(() => {
    if (!clock.live || playing) return;
    const id = window.setInterval(() => {
      setClock((c) => (c.live ? { minute: Math.max(span.start, Math.min(span.end, nowInTimezone(data.timezone))), live: true } : c));
    }, 15_000);
    return () => window.clearInterval(id);
  }, [clock.live, playing, span, data.timezone]);

  React.useEffect(() => {
    if (!playing) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setInterval(
      () => {
        const next = playStep(minuteRef.current, reduced, slots, span);
        if (next === null) setPlaying(false);
        else setClock({ minute: next, live: false });
      },
      reduced ? 1500 : 320,
    );
    return () => window.clearInterval(id);
  }, [playing, slots, span]);

  const setNow = React.useCallback((minute: number) => {
    setPlaying(false);
    setClock({ minute, live: false });
  }, []);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (clock.minute >= span.end) setClock({ minute: span.start, live: false });
    setPlaying(true);
  };

  // Cmd-K
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const isMac = useIsMac();

  // Selection
  const selected = sel ? (model.personById.get(sel) ?? null) : null;
  const select = React.useCallback((personId: string, slot?: number) => {
    setFocusSlot(slot ?? null);
    setPicker(null);
    if (new URLSearchParams(window.location.search).get("sel") !== personId) writeParams({ sel: personId });
  }, [setFocusSlot, setPicker]);
  const closeSheet = () => {
    setPicker(null);
    setFocusSlot(null);
    writeParams({ sel: null });
  };

  const openSlot = React.useCallback(
    (personId: string, slot: number) => {
      select(personId, slot);
      const person = model.personById.get(personId);
      const s = slots.find((x) => x.slot === slot);
      if (person?.kind === "supplier" && s) {
        setPicker({
          supplierId: person.id,
          supplierName: person.name,
          slot,
          slotLabel: `${s.start} to ${s.end}`,
        });
      }
    },
    [model, slots, select, setPicker],
  );

  const setView = (next: ViewId) => {
    if (next === "slot" && free) setSlotPick(free);
    writeParams({ view: next === "supplier" ? null : next });
  };
  const setFree = (slot: number) => {
    if (slot) setSlotPick(slot);
    writeParams({ free: slot ? String(slot) : null });
  };
  const setSearch = (value: string) => {
    setQ(value);
    setSeenQParam(value);
    writeParams({ q: value }, "replace");
  };
  const clearFilters = () => {
    setQ("");
    setSeenQParam("");
    setFlagged(false);
    writeParams({ q: null, free: null });
  };
  const showFree = (slot: number) => {
    setSlotPick(slot);
    // Free buyers are the useful list; a supplier view filtered to a busy slot is usually empty.
    writeParams({ free: String(slot), view: view === "supplier" ? "buyer" : view });
  };

  // Derived
  const attention = attentionCount(model, targets);
  const timelineMode = view === "supplier" || view === "buyer" ? view : null;
  const lanes = React.useMemo(
    () => (timelineMode ? lanesFor(model, timelineMode, { q, free, flagged }, targets) : []),
    [model, timelineMode, q, free, flagged, targets],
  );
  const phase = phaseAt(clock.minute, slots);
  const liveSlot = slotAtMinute(clock.minute, slots);
  const activeBuyers = model.buyers.filter((b) => !b.withdrawn);
  const activeSuppliers = model.suppliers.filter((s) => !s.withdrawn);
  const counts = {
    desksBusy: phase.phase === "in" ? busyCount(model, model.suppliers, phase.slot.slot) : 0,
    desks: activeSuppliers.length,
    buyersBusy: phase.phase === "in" ? busyCount(model, activeBuyers, phase.slot.slot) : 0,
    buyers: activeBuyers.length,
    movingNext: phase.phase === "gap" ? busyCount(model, model.buyers, phase.next.slot) : 0,
    appointments: data.appointments.length,
  };
  const nowText = `${clockParts(clock.minute).time} ${clockParts(clock.minute).meridiem}`;
  const boardSlot = free || slotPick || focusSlotAt(clock.minute, slots) || slots[0]?.slot || 1;
  const buyersBelowMin = model.buyers.filter((b) => healthOf(b, targets) === "under").length;
  const anyFilter = q !== "" || free !== 0 || flagged;

  const resultLine = (() => {
    const parts: string[] = [];
    if (timelineMode) {
      const total = (timelineMode === "supplier" ? model.suppliers : model.buyers).filter(
        (p) => !p.withdrawn || p.count > 0,
      ).length;
      const noun = timelineMode === "supplier" ? "supplier desk" : "buyer";
      parts.push(lanes.length === total ? `All ${total} ${noun}s` : `${lanes.length} of ${total} ${noun}s`);
      if (free) parts.push(`free in slot ${free}`);
      if (flagged) parts.push("with count problems");
    } else if (view === "slot") {
      parts.push(`Slot ${boardSlot}`);
    } else {
      parts.push("Whole schedule");
    }
    if (q.trim()) parts.push(`matching “${q.trim()}”`);
    return parts.join(", ");
  })();

  const statusBadge = locked ? (
    <Badge variant="default">
      <LockIcon />
      {data.status === "locked" ? "Locked, ready to send" : data.status === "sent" ? "Locked and sent" : "Archived"}
    </Badge>
  ) : (
    <Badge variant="outline">
      <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
      Draft, not locked
    </Badge>
  );

  const editButton = (
    <Toggle
      variant="outline"
      size="lg"
      pressed={editingOn}
      onPressedChange={setEditing}
      disabled={locked}
      aria-label={editingOn ? "Stop editing" : "Edit schedule"}
      className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
    >
      <PencilIcon data-icon="inline-start" />
      {editingOn ? "Editing" : "Edit schedule"}
    </Toggle>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="Schedule"
        status={statusBadge}
        actions={
          <>
            <Button variant="outline" size="lg" asChild>
              <Link href={eventSectionHref(eventId, "matching")}>
                <RefreshCwIcon data-icon="inline-start" />
                Run matching
              </Link>
            </Button>
            {locked ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    {editButton}
                  </span>
                </TooltipTrigger>
                <TooltipContent>Unlock the schedule to edit it.</TooltipContent>
              </Tooltip>
            ) : (
              editButton
            )}
            {locked ? (
              canUnlock ? (
                <Button size="lg" variant="outline" onClick={() => setUnlockOpen(true)}>
                  <LockOpenIcon data-icon="inline-start" />
                  Unlock schedule
                </Button>
              ) : null
            ) : (
              <Button size="lg" onClick={() => setLockOpen(true)}>
                <LockIcon data-icon="inline-start" />
                Lock schedule
              </Button>
            )}
            <Button variant="outline" size="lg" asChild>
              <Link href={eventSectionHref(eventId, "exports")}>
                <DownloadIcon data-icon="inline-start" />
                Export
              </Link>
            </Button>
          </>
        }
      />

      {locked ? (
        <Alert>
          <LockIcon />
          <AlertTitle>
            {data.status === "archived" ? "This event is archived" : "The schedule is locked"}
          </AlertTitle>
          <AlertDescription>
            {data.status === "archived"
              ? "Nothing can change. Exports stay available."
              : "Desks are assigned and participant links are issued. Unlock it to edit or re-run matching."}
          </AlertDescription>
        </Alert>
      ) : editingOn ? (
        <Alert>
          <PencilIcon />
          <AlertTitle>Editing the schedule</AlertTitle>
          <AlertDescription>
            Click a meeting or an open slot. Changes save straight away, show in the activity log, and can be undone there.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-y bg-card px-3 py-2.5 max-sm:-mx-4 sm:rounded-lg sm:border">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={view}
          onValueChange={(v) => v && setView(v as ViewId)}
          aria-label="View"
          className="max-w-full overflow-x-auto max-sm:w-full"
        >
          {VIEWS.map((v) => (
            <ToggleGroupItem
              key={v.id}
              value={v.id}
              className="px-2.5 font-semibold max-sm:grow max-sm:px-2"
              aria-label={v.id === "quality" && attention ? `${v.label}, ${attention} need attention` : v.label}
            >
              {v.label}
              {v.id === "quality" && attention ? (
                <Badge className="h-[18px] bg-destructive px-1.5 text-[11px] text-destructive-foreground tabular-nums">
                  {attention}
                </Badge>
              ) : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <InputGroup className="h-8 min-w-0 flex-1 basis-56 sm:max-w-sm">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={q}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search buyer, organization or supplier"
            aria-label="Search buyer, organization or supplier"
            autoComplete="off"
          />
          <InputGroupAddon align="inline-end" className="max-sm:hidden">
            <InputGroupButton size="xs" aria-label="Open quick find" onClick={() => setCmdOpen(true)}>
              <KbdGroup>
                <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>K</Kbd>
              </KbdGroup>
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <SlotFilter slots={slots} value={free} onChange={setFree} />
        {view !== "quality" ? (
          <Toggle
            variant="outline"
            pressed={flagged}
            onPressedChange={setFlagged}
            className="font-semibold data-[state=on]:border-destructive data-[state=on]:bg-destructive data-[state=on]:text-destructive-foreground"
          >
            <AlertTriangleIcon data-icon="inline-start" />
            Count problems only
          </Toggle>
        ) : null}
        {anyFilter ? (
          <Button variant="ghost" onClick={clearFilters} className="text-muted-foreground">
            Clear filters
          </Button>
        ) : null}
        <p className="text-sm text-muted-foreground max-lg:w-full lg:ml-auto" aria-live="polite">
          {resultLine}
        </p>
      </div>

      {view !== "quality" ? (
        <>
          <ClockStrip
            now={clock.minute}
            phase={phase}
            slots={slots}
            counts={counts}
            live={clock.live}
            playing={playing}
            fade={fade}
            onPrev={() => setNow(prevSlotStart(clock.minute, slots, span))}
            onNext={() => setNow(nextSlotStart(clock.minute, slots, span))}
            onPlay={togglePlay}
            onFade={setFade}
            onShowFree={showFree}
          />
          <Legend topN={topN} />
        </>
      ) : null}

      {timelineMode ? (
        lanes.length ? (
          <Timeline
            mode={timelineMode}
            lanes={lanes}
            totalLanes={(timelineMode === "supplier" ? model.suppliers : model.buyers).length}
            model={model}
            slots={slots}
            span={span}
            topN={topN}
            targets={targets}
            query={query}
            free={free}
            selectedId={sel}
            focusSlot={focusSlot}
            liveSlot={liveSlot}
            editing={editingOn}
            now={clock.minute}
            nowText={nowText}
            fade={fade}
            playing={playing}
            onNowChange={setNow}
            onSelect={select}
            onOpenSlot={openSlot}
          />
        ) : (
          <Empty className="border bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon />
              </EmptyMedia>
              <EmptyTitle>{free ? `No one free in slot ${free}` : "No matches"}</EmptyTitle>
              <EmptyDescription>
                {free
                  ? timelineMode === "supplier"
                    ? `Every supplier desk is booked in slot ${free}. Open slots live with buyers below target.`
                    : `Every buyer is in a meeting in slot ${free}${q ? " among those matching your search" : ""}.`
                  : flagged && !q
                    ? "Nobody in this view has a count problem."
                    : `Nothing matches “${q.trim()}”. Search covers supplier names, buyer organizations and titles.`}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row flex-wrap justify-center">
              {free && timelineMode === "supplier" ? (
                <Button variant="outline" onClick={() => setView("buyer")}>
                  Show free buyers instead
                </Button>
              ) : null}
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            </EmptyContent>
          </Empty>
        )
      ) : view === "slot" ? (
        <SlotBoard
          model={model}
          slots={slots}
          slot={boardSlot}
          liveSlot={liveSlot}
          onPick={(n) => {
            setSlotPick(n);
            if (free) writeParams({ free: String(n) });
          }}
          query={query}
          flagged={flagged}
          targets={targets}
          topN={topN}
          onSelect={select}
        />
      ) : (
        <QualityView
          stats={run.stats}
          warnings={run.warnings}
          model={model}
          slots={slots}
          appointments={data.appointments}
          targets={targets}
          query={query}
          onSelect={select}
        />
      )}

      <PersonSheet
        person={selected}
        model={model}
        slots={slots}
        targets={targets}
        topN={topN}
        editing={editingOn}
        runId={run.id}
        version={version}
        focusSlot={focusSlot}
        picker={picker}
        onPickerChange={setPicker}
        onVersion={onVersion}
        onSelect={select}
        onClose={closeSheet}
      />

      <CommandMenu
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        model={model}
        slots={slots}
        targets={targets}
        view={view}
        editing={editingOn}
        locked={locked}
        canUnlock={canUnlock}
        onSelectPerson={(id) => select(id)}
        onSelectSlot={(n) => {
          setSlotPick(n);
          writeParams({ view: "slot", free: free ? String(n) : null });
        }}
        onView={setView}
        onToggleEdit={() => setEditing((e) => !e)}
        onLock={() => setLockOpen(true)}
        onUnlock={() => setUnlockOpen(true)}
      />

      <LockDialog
        open={lockOpen}
        onOpenChange={setLockOpen}
        eventId={eventId}
        appointments={data.appointments.length}
        buyersBelowMin={buyersBelowMin}
        buyerMin={targets.buyerMin}
      />
      <UnlockDialog open={unlockOpen} onOpenChange={setUnlockOpen} eventId={eventId} />
    </div>
  );
}
