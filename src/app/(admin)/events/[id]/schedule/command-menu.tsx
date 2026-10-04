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
import { healthOf, personLabel, VIEWS, type ScheduleModel, type Targets, type ViewId } from "./schedule-model";

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

/** Cmd-K: jump to a buyer, supplier, or slot, or run a workspace action. */
export function CommandMenu(props: CommandMenuProps) {
  const { open, onOpenChange, model, slots, targets, view, editing, locked, canUnlock } = props;
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Find a buyer or supplier"
      description="Search people and slots, or run an action"
      className="sm:max-w-xl"
    >
      <Command>
        <CommandInput placeholder="Type a buyer, organization, supplier, or desk" />
        <CommandList className="max-h-[56dvh]">
          <CommandEmpty>No buyer, supplier, or action matches that.</CommandEmpty>
          <CommandGroup heading="Actions">
            {VIEWS.filter((v) => v.id !== view).map((v) => (
              <CommandItem key={v.id} value={`Show ${v.label}`} onSelect={() => run(() => props.onView(v.id))}>
                <LayoutGridIcon />
                Show {v.label.toLowerCase()}
              </CommandItem>
            ))}
            {!locked ? (
              <CommandItem value={editing ? "Stop editing" : "Edit schedule"} onSelect={() => run(props.onToggleEdit)}>
                <PencilIcon />
                {editing ? "Stop editing" : "Edit schedule"}
              </CommandItem>
            ) : null}
            {!locked ? (
              <CommandItem value="Lock schedule" onSelect={() => run(props.onLock)}>
                <LockIcon />
                Lock schedule
              </CommandItem>
            ) : canUnlock ? (
              <CommandItem value="Unlock schedule" onSelect={() => run(props.onUnlock)}>
                <LockOpenIcon />
                Unlock schedule
              </CommandItem>
            ) : null}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Suppliers">
            {model.suppliers.map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.name} desk ${s.desk ?? ""} ${s.id}`}
                onSelect={() => run(() => props.onSelectPerson(s.id))}
                className="gap-3"
              >
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
          <CommandSeparator />
          <CommandGroup heading="Buyers">
            {model.buyers.map((b) => {
              const label = personLabel(b);
              return (
                <CommandItem
                  key={b.id}
                  value={`${b.name} ${b.organization ?? ""} ${b.title ?? ""} ${b.id}`}
                  onSelect={() => run(() => props.onSelectPerson(b.id))}
                  className="gap-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{label.primary}</span>
                    {label.secondary ? <span className="block truncate text-xs text-muted-foreground">{label.secondary}</span> : null}
                  </span>
                  <CountChip count={b.count} health={healthOf(b, targets)} className={cn(b.withdrawn && "opacity-60")} />
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Slots">
            {slots.map((s) => (
              <CommandItem key={s.slot} value={`Slot ${s.slot} ${s.start}`} onSelect={() => run(() => props.onSelectSlot(s.slot))}>
                <ClockIcon />
                <span className="tabular-nums">
                  Slot {s.slot}, {s.start} to {s.end}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
