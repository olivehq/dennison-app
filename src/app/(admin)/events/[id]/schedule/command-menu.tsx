"use client";

import * as React from "react";
import { ClockIcon, LayoutGridIcon, LockIcon, LockOpenIcon, PencilIcon } from "lucide-react";
import { cn } from "cn";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type { ScheduleSlot } from "@/server/schedule/queries";
import { CountChip } from "./count-chip";
import { TYPE_LABEL } from "@/components/app/appointment-block";
import {
  healthOf,
  matchesSearch,
  personLabel,
  slotSearchFields,
  VIEWS,
  type BuyerPerson,
  type ScheduleModel,
  type SupplierPerson,
  type Targets,
  type ViewId,
} from "./schedule-model";

type CommandMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ScheduleModel;
  slots: ScheduleSlot[];
  targets: Targets;
  view: ViewId;
  editing: boolean;
  locked: boolean;
  canUnlock: boolean;
  onSelectPerson: (personId: string) => void;
  onSelectSlot: (slot: number) => void;
  onView: (view: ViewId) => void;
  onToggleEdit: () => void;
  onLock: () => void;
  onUnlock: () => void;
};

type Action = { id: string; label: string; icon: React.ReactNode; run: () => void };

const supplierSearchFields = (s: SupplierPerson) => [s.name, s.desk === null ? null : `desk ${s.desk}`];
const buyerSearchFields = (b: BuyerPerson) => [b.name, b.organization, b.title];

/** Cmd-K: jump to a buyer, supplier, or slot, or run a workspace action. */
export function CommandMenu(props: CommandMenuProps) {
  const { open, onOpenChange, model, slots, targets, view, editing, locked, canUnlock } = props;
  const [search, setSearch] = React.useState("");
  // Each opening starts with an empty search, however it was closed (Esc, Cmd-K, or a pick).
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSearch("");
  }
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const actions: Action[] = [
    ...VIEWS.filter((v) => v.id !== view).map((v) => ({
      id: `view-${v.id}`,
      label: `Show ${v.label.toLowerCase()}`,
      icon: <LayoutGridIcon />,
      run: () => props.onView(v.id),
    })),
    ...(!locked
      ? [
          { id: "edit", label: editing ? "Stop editing" : "Edit schedule", icon: <PencilIcon />, run: props.onToggleEdit },
          { id: "lock", label: "Lock schedule", icon: <LockIcon />, run: props.onLock },
        ]
      : canUnlock
        ? [{ id: "unlock", label: "Unlock schedule", icon: <LockOpenIcon />, run: props.onUnlock }]
        : []),
  ].filter((a) => matchesSearch(search, [a.label]));
  const suppliers = model.suppliers.filter((s) => matchesSearch(search, supplierSearchFields(s)));
  const buyers = model.buyers.filter((b) => matchesSearch(search, buyerSearchFields(b)));
  const slotMatches = slots.filter((s) => matchesSearch(search, slotSearchFields(s)));
  const groups = [actions.length, suppliers.length, buyers.length, slotMatches.length];
  // A separator goes before every non-empty group except the first one shown.
  const separatorBefore = (index: number) => groups[index] > 0 && groups.slice(0, index).some((n) => n > 0);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Find a buyer or supplier"
      description="Search people and slots, or run an action"
      // Sits about 15% from the top at a fixed height, so it doesn't jump while you type.
      className="top-[15%] h-[min(32rem,70dvh)] sm:max-w-xl"
    >
      <Command shouldFilter={false}>
        <CommandInput value={search} onValueChange={setSearch} placeholder="Type a buyer, organization, supplier, or desk" />
        <CommandList className="max-h-none min-h-0 flex-1">
          <CommandEmpty>No buyer, supplier, slot, or action matches that. Check the spelling or try fewer words.</CommandEmpty>
          {actions.length ? (
            <CommandGroup heading="Actions">
              {actions.map((a) => (
                <CommandItem key={a.id} value={a.id} onSelect={() => run(a.run)}>
                  {a.icon}
                  {a.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {separatorBefore(1) ? <CommandSeparator /> : null}
          {suppliers.length ? (
            <CommandGroup heading="Suppliers">
              {suppliers.map((s) => (
                <CommandItem key={s.id} value={s.id} onSelect={() => run(() => props.onSelectPerson(s.id))} className="gap-3">
                  <span className="inline-grid h-6 min-w-7 shrink-0 place-items-center rounded-sm bg-secondary px-1 font-display text-[13px] font-bold tabular-nums">
                    {s.desk ?? "–"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{s.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{TYPE_LABEL[s.type]}</span>
                  </span>
                  <CountChip count={s.count} health={healthOf(s, targets)} />
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {separatorBefore(2) ? <CommandSeparator /> : null}
          {buyers.length ? (
            <CommandGroup heading="Buyers">
              {buyers.map((b) => {
                const label = personLabel(b);
                return (
                  <CommandItem key={b.id} value={b.id} onSelect={() => run(() => props.onSelectPerson(b.id))} className="gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{label.primary}</span>
                      {label.secondary ? <span className="block truncate text-xs text-muted-foreground">{label.secondary}</span> : null}
                    </span>
                    <CountChip count={b.count} health={healthOf(b, targets)} className={cn(b.withdrawn && "opacity-60")} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}
          {separatorBefore(3) ? <CommandSeparator /> : null}
          {slotMatches.length ? (
            <CommandGroup heading="Slots">
              {slotMatches.map((s) => (
                <CommandItem key={s.slot} value={`slot-${s.slot}`} onSelect={() => run(() => props.onSelectSlot(s.slot))}>
                  <ClockIcon />
                  <span className="tabular-nums">
                    Slot {s.slot}, {s.start} to {s.end}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
