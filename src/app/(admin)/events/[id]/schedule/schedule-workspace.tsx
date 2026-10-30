"use client";

import * as React from "react";
import {
  ArmchairIcon,
  DownloadIcon,
  EllipsisIcon,
  ListFilterIcon,
  LockIcon,
  LockOpenIcon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "cn";
import { PageHeader } from "@/components/app/page-header";
import { SlotFilter } from "@/components/app/slot-filter";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { eventAllows } from "@/lib/event-gates";
import { nowInTimezone } from "@/lib/time";
import { eventSectionHref } from "../event-sections";
import { ClockStrip } from "./clock-strip";
import { CommandMenu } from "./command-menu";
import { Legend } from "./legend";
import { LockDialog, UnlockDialog } from "./lock-dialogs";
import { PersonSheet } from "./person-sheet";
import { QualityView } from "./quality-view";
import { ReassignDesksDialog } from "./reassign-desks-button";
import {
  activeFilters,
  attentionCount,
  buildModel,
  busyCount,
  emptyLanesText,
  filtersFor,
  healthOf,
  isBelowTarget,
  isLockedStatus,
  lanesFor,
  needAttentionText,
  laneTotal,
  normalizeQuery,
  personLabel,
  pickerFor,
  readUrlState,
  resultLine,
  sameUrlState,
  VIEWS,
  writeUrlState,
  type FilterKey,
  type ViewId,
  type WorkspaceData,
  type WorkspaceUrlState,
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

/** One checkbox row in the Filters popover. */
function FilterCheckbox({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = React.useId();
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} checked={checked} onCheckedChange={(on) => onChange(on === true)} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
    </Field>
  );
}

function urlFor(qs: string): string {
  return qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
}

/**
 * View, search, filters, and the selected person (`WorkspaceUrlState`). React
 * state is the source of truth and the URL mirrors it, so a link, a refresh,
 * or Back reproduces the screen.
 *
 * The screen does not read `useSearchParams` after the first render. Next.js
 * routes a History API change through its router queue, and after a save
 * (which invalidates its cache) that queue waits on the server: on Vercel the
 * sheet opened seconds late, and a request started before a filter change
 * could put its older URL back, dropping the view and the filters. So:
 * clicks update state at once; Back and Forward (popstate) read the URL; and
 * if the router ever writes a URL that disagrees with the state, the state
 * is written back.
 */
function useWorkspaceUrlState(slots: readonly { slot: number }[]) {
  const searchParams = useSearchParams();
  const [state, setState] = React.useState(() => readUrlState(searchParams, slots));
  const stateRef = React.useRef(state);

  const update = React.useCallback((patch: Partial<WorkspaceUrlState>, mode: "push" | "replace" = "push") => {
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
    const url = urlFor(writeUrlState(window.location.search, patch));
    if (mode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, []);

  React.useEffect(() => {
    const onPopState = () => {
      stateRef.current = readUrlState(new URLSearchParams(window.location.search), slots);
      setState(stateRef.current);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [slots]);

  React.useEffect(() => {
    // After the current event: React renders a Back or Forward synchronously inside
    // Next.js's popstate listener, before the listener above has read the new URL.
    const id = window.setTimeout(() => {
      const inUrl = readUrlState(new URLSearchParams(window.location.search), slots);
      if (!sameUrlState(inUrl, stateRef.current)) {
        window.history.replaceState(null, "", urlFor(writeUrlState(window.location.search, stateRef.current)));
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [searchParams, slots]);

  return [state, update, stateRef] as const;
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
  const canUnlock = eventAllows("locked", data.status);

  // URL state
  const [urlState, updateUrl, urlRef] = useWorkspaceUrlState(slots);
  const { view, free, slot: slotPick, sel, q, problems, withdrawn, neither } = urlState;
  // The box shows `q` at once; the lanes follow a render behind so typing stays responsive.
  const deferredQ = React.useDeferredValue(q);
  // The URL keeps every filter so switching views restores it, but a filter only counts in a view that shows it.
  const flagged = problems && filtersFor(view).includes("problems");
  const withdrawnOnly = withdrawn && filtersFor(view).includes("withdrawn");
  const mostlyNeither = neither && filtersFor(view).includes("neither");
  const query = normalizeQuery(deferredQ);

  // Local state
  const [editing, setEditing] = React.useState(false);
  const editingOn = editing && !locked;
  // Both belong to one person. Back and Forward change `sel` without touching them, so each is
  // ignored unless it was opened for the person now selected.
  const [focus, setFocus] = React.useState<{ personId: string; slot: number } | null>(null);
  const [openPicker, setPicker] = React.useState<PickerRequest | null>(null);
  const focusSlot = focus && focus.personId === sel ? focus.slot : null;
  const picker = pickerFor(openPicker, sel);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [lockOpen, setLockOpen] = React.useState(false);
  const [unlockOpen, setUnlockOpen] = React.useState(false);
  const [reassignOpen, setReassignOpen] = React.useState(false);
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
  // Reads the current selection from the ref so `select` and `openSlot` keep one identity
  // and a click does not re-render every lane through the memoised timeline.
  const select = React.useCallback(
    (personId: string, slot?: number) => {
      setFocus(slot === undefined ? null : { personId, slot });
      setPicker(null);
      if (urlRef.current.sel !== personId) updateUrl({ sel: personId });
    },
    [urlRef, updateUrl],
  );
  const closeSheet = () => {
    setPicker(null);
    setFocus(null);
    updateUrl({ sel: null });
  };

  // "+ Open" on a lane: select the person and open the picker for that slot.
  // Suppliers get buyers, buyers get suppliers; withdrawn people get no new meetings.
  const openSlot = React.useCallback(
    (personId: string, slot: number) => {
      select(personId, slot);
      const person = model.personById.get(personId);
      const s = slots.find((x) => x.slot === slot);
      if (!person || person.withdrawn || !s) return;
      const slotLabel = `${s.start} to ${s.end}`;
      setPicker(
        person.kind === "supplier"
          ? { pick: "buyer", ownerId: person.id, supplierId: person.id, supplierName: person.name, slot, slotLabel }
          : { pick: "supplier", ownerId: person.id, buyerId: person.id, buyerName: personLabel(person).primary, slot, slotLabel },
      );
    },
    [model, slots, select],
  );

  // On the By slot tab, "Free in" picks the board's slot too, and clearing it leaves the board where it is.
  const setView = (next: ViewId) => updateUrl(next === "slot" && free ? { view: next, slot: free } : { view: next });
  const setFree = (slot: number) => updateUrl(view === "slot" ? { free: slot, slot: slot || boardSlot } : { free: slot });
  const setSearch = (value: string) => updateUrl({ q: value }, "replace");
  const removeFilter = (key: FilterKey) => {
    if (key === "free") setFree(0);
    else if (key === "problems") updateUrl({ problems: false });
    else if (key === "withdrawn") updateUrl({ withdrawn: false });
    else updateUrl({ neither: false });
  };
  const clearFilters = () =>
    updateUrl({
      q: "",
      free: 0,
      problems: false,
      withdrawn: false,
      neither: false,
      ...(view === "slot" ? { slot: boardSlot } : {}),
    });
  const showFree = (slot: number) =>
    // Free buyers are the useful list; a supplier view filtered to a busy slot is usually empty.
    updateUrl({ free: slot, view: view === "supplier" ? "buyer" : view, ...(view === "slot" ? { slot } : {}) });

  // Derived
  const attention = attentionCount(model, targets) + data.withdrawn.length;
  const timelineMode = view === "supplier" || view === "buyer" ? view : null;
  const lanes = React.useMemo(
    () =>
      timelineMode ? lanesFor(model, timelineMode, { q: deferredQ, free, flagged, withdrawnOnly, mostlyNeither }, targets) : [],
    [model, timelineMode, deferredQ, free, flagged, withdrawnOnly, mostlyNeither, targets],
  );
  const emptyText = emptyLanesText({ mode: timelineMode ?? "buyer", free, q: deferredQ, flagged, withdrawnOnly, mostlyNeither });
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
  const suppliersBelowTarget = model.suppliers.filter((s) => isBelowTarget(s, targets)).length;
  const shownFilters = filtersFor(view);
  const active = activeFilters({ view, free, problems, withdrawn, neither });
  const anyFilter = q !== "" || active.length > 0;
  const results = resultLine({
    view,
    lanes: { shown: lanes.length, total: timelineMode ? laneTotal(model, timelineMode) : 0 },
    boardSlot,
    q: deferredQ,
    active: active.map((f) => f.key),
    free,
  });

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

  // It opens the matching page, where the run happens, so the label says "Go to".
  const matchingButton = locked ? (
    <Button variant="outline" size="lg" disabled>
      <RefreshCwIcon data-icon="inline-start" />
      Go to matching
    </Button>
  ) : (
    <Button variant="outline" size="lg" asChild>
      <Link href={eventSectionHref(eventId, "matching")}>
        <RefreshCwIcon data-icon="inline-start" />
        Go to matching
      </Link>
    </Button>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        // No status pill: the app shell's breadcrumb line shows the event status on every section page.
        // Lock schedule, or Unlock schedule plus the locked alert below, says where the schedule stands.
        title="Schedule"
        actions={
          <>
            {locked ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    {matchingButton}
                  </span>
                </TooltipTrigger>
                <TooltipContent>Unlock the schedule to run matching again.</TooltipContent>
              </Tooltip>
            ) : (
              matchingButton
            )}
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
                <Button size="lg" onClick={() => setUnlockOpen(true)}>
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-lg" aria-label="More actions">
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {/* Desks are fixed once the schedule is locked (D17). */}
                {locked ? null : (
                  <DropdownMenuItem onSelect={() => setReassignOpen(true)}>
                    <ArmchairIcon />
                    Reassign desks
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link href={eventSectionHref(eventId, "exports")}>
                    <DownloadIcon />
                    Go to exports
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
            Click a meeting or an open slot. You see what each change does before you save it. Saved changes show in the
            activity log and can be undone there.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Toolbar: one row from lg up. Filters and Key hold what used to be toggles and a three-line legend. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            value={view}
            onValueChange={(v) => v && setView(v as ViewId)}
            aria-label="View"
            className="max-w-full shrink-0 overflow-x-auto max-sm:w-full"
          >
            {VIEWS.map((v) => (
              <ToggleGroupItem
                key={v.id}
                value={v.id}
                className="px-2.5 font-semibold max-sm:grow max-sm:px-2"
                aria-label={v.id === "quality" && attention ? `${v.label}, ${needAttentionText(attention)}` : v.label}
              >
                {"short" in v ? v.short : v.label}
                {v.id === "quality" && attention ? (
                  <Badge className="h-[18px] bg-destructive px-1.5 text-[11px] text-destructive-foreground tabular-nums">
                    {attention}
                  </Badge>
                ) : null}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <InputGroup className="h-8 min-w-0 flex-1 basis-56 max-sm:basis-full lg:max-w-md">
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
          {view !== "quality" ? (
            <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant={active.length ? "default" : "outline"}
                    aria-label={active.length ? `Filters, ${active.length} on` : "Filters"}
                    className="max-sm:flex-1"
                  >
                    <ListFilterIcon data-icon="inline-start" />
                    {active.length ? `Filters · ${active.length}` : "Filters"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" aria-label="Filters" collisionPadding={16} className="w-80 gap-4 p-4">
                  <PopoverHeader>
                    <PopoverTitle className="font-semibold">Filters</PopoverTitle>
                  </PopoverHeader>
                  <FieldGroup className="gap-4">
                    <SlotFilter slots={slots} value={free} onChange={setFree} className="justify-between" />
                    <FilterCheckbox
                      label="Count problems only"
                      description="People below or above their meeting target."
                      checked={flagged}
                      onChange={(on) => updateUrl({ problems: on })}
                    />
                    {shownFilters.includes("withdrawn") ? (
                      <FilterCheckbox
                        label="Withdrawn only"
                        description="Lanes with a meeting with someone who withdrew."
                        checked={withdrawnOnly}
                        onChange={(on) => updateUrl({ withdrawn: on })}
                      />
                    ) : null}
                    {shownFilters.includes("neither") ? (
                      <FilterCheckbox
                        label="Mostly neither"
                        description={`Most meetings are ones neither side ranked top ${topN}.`}
                        checked={mostlyNeither}
                        onChange={(on) => updateUrl({ neither: on })}
                      />
                    ) : null}
                  </FieldGroup>
                </PopoverContent>
              </Popover>
              <Legend topN={topN} className="max-sm:flex-1" />
            </div>
          ) : null}
        </div>
        {/* Chips and the result line show only while a filter or a search is on; the lane header has the count otherwise. */}
        <div className={cn("flex flex-wrap items-center gap-2", !anyFilter && "sr-only")}>
          {active.map((f) => (
            <Button
              key={f.key}
              variant="secondary"
              size="sm"
              className="rounded-full pr-1.5"
              aria-label={`Remove filter: ${f.label}`}
              onClick={() => removeFilter(f.key)}
            >
              {f.label}
              <XIcon data-icon="inline-end" />
            </Button>
          ))}
          <p className="text-sm text-muted-foreground max-sm:order-last max-sm:w-full" aria-live="polite">
            {results}
          </p>
          {anyFilter ? (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto text-muted-foreground">
              Clear filters
            </Button>
          ) : null}
        </div>
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
        </>
      ) : null}

      {timelineMode ? (
        lanes.length ? (
          <Timeline
            mode={timelineMode}
            lanes={lanes}
            totalLanes={laneTotal(model, timelineMode)}
            model={model}
            slots={slots}
            span={span}
            topN={topN}
            targets={targets}
            query={query}
            free={free}
            selectedId={sel}
            focusSlot={focusSlot}
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
              <EmptyTitle>{emptyText.title}</EmptyTitle>
              <EmptyDescription>{emptyText.description}</EmptyDescription>
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
          live={clock.live}
          onPick={(n) => updateUrl(free ? { slot: n, free: n } : { slot: n })}
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
          withdrawn={data.withdrawn}
          manualChanges={data.manualChanges}
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
        onSelectSlot={(n) => updateUrl({ view: "slot", slot: n, free: free ? n : 0 })}
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
        suppliersBelowTarget={suppliersBelowTarget}
        supplierTarget={targets.supplierTarget}
        withdrawn={data.withdrawn.length}
      />
      <UnlockDialog open={unlockOpen} onOpenChange={setUnlockOpen} eventId={eventId} />
      {locked ? null : <ReassignDesksDialog eventId={eventId} open={reassignOpen} onOpenChange={setReassignOpen} />}
    </div>
  );
}
