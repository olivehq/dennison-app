"use client";

import * as React from "react";
import { cn } from "cn";
import { MutualIcon, strengthLabel, treatmentClass, TYPE_LABEL, typeDotClass } from "@/components/app/appointment-block";
import { RankBadge } from "@/components/app/rank-badge";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ScheduleSlot } from "@/server/schedule/queries";
import { CountChip } from "./count-chip";
import {
  appointmentsOf,
  byFewest,
  freeIn,
  healthOf,
  healthText,
  personLabel,
  personMatches,
  type ScheduleModel,
  type Targets,
} from "./schedule-model";

type SlotBoardProps = {
  model: ScheduleModel;
  slots: ScheduleSlot[];
  slot: number;
  liveSlot: number | null;
  onPick: (slot: number) => void;
  query: string;
  flagged: boolean;
  targets: Targets;
  topN: number;
  onSelect: (personId: string, slot?: number) => void;
};

/** By slot: who sits at each desk in one slot, and who is free. */
export function SlotBoard({ model, slots, slot, liveSlot, onPick, query, flagged, targets, topN, onSelect }: SlotBoardProps) {
  const current = slots.find((s) => s.slot === slot) ?? slots[0];
  const rows = model.suppliers
    .map((s) => ({ supplier: s, appointment: appointmentsOf(model, s.id).get(current.slot) }))
    .filter((r) => r.appointment !== undefined)
    .map((r) => ({ ...r, appointment: r.appointment!, buyer: model.personById.get(r.appointment!.buyerId)! }))
    .filter((r) => r.buyer !== undefined)
    .filter((r) => !flagged || healthOf(r.buyer, targets) !== "ok" || healthOf(r.supplier, targets) !== "ok")
    .filter((r) => !query || personMatches(r.supplier, query) || personMatches(r.buyer, query));
  const mix = { mutual: 0, one: 0, neither: 0, blank: 0 };
  for (const s of model.suppliers) {
    const a = appointmentsOf(model, s.id).get(current.slot);
    if (!a) continue;
    if (a.strength === "buyer" || a.strength === "supplier") mix.one++;
    else mix[a.strength]++;
  }
  const allFree = freeIn(model, model.buyers, current.slot);
  const freeBuyers = byFewest(allFree)
    .filter((b) => !query || personMatches(b, query))
    .filter((b) => !flagged || healthOf(b, targets) !== "ok");
  const freeSuppliers = freeIn(model, model.suppliers, current.slot).filter((s) => !query || personMatches(s, query));

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-card">
      <div className="border-b px-3 py-2.5 sm:px-4">
        <ToggleGroup
          type="single"
          value={String(current.slot)}
          onValueChange={(v) => v && onPick(Number(v))}
          aria-label="Choose a slot"
          className="w-full overflow-x-auto pb-0.5"
          spacing={1}
        >
          {slots.map((s) => (
            <ToggleGroupItem
              key={s.slot}
              value={String(s.slot)}
              aria-label={`Slot ${s.slot}, ${s.start} to ${s.end}${liveSlot === s.slot ? ", happening now" : ""}`}
              className="relative h-auto flex-col items-start gap-1 px-3 py-1.5 text-left data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              <span className="font-display text-[15px] leading-none font-bold">Slot {s.slot}</span>
              <span className="text-xs tabular-nums opacity-80">
                {s.start.replace(/\s*[AP]M$/, "")} to {s.end}
              </span>
              {liveSlot === s.slot ? (
                <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-now" />
              ) : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="grid min-h-0 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="slot-table-title" className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-2">
            <h2 id="slot-table-title" className="font-display text-lg font-bold">
              At the desks, {current.start} to {current.end}
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {mix.mutual} mutual top {topN}, {mix.one} one side, {mix.neither} neither, {mix.blank} blank
            </p>
          </div>
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14 pl-4">Desk</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Buyer</TableHead>
                  <TableHead className="text-right">
                    <span title="How the buyer ranked this supplier, and how the supplier ranked this buyer">Ranks</span>
                  </TableHead>
                  <TableHead className="pr-4 max-sm:hidden">Match</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ supplier, buyer, appointment: a }) => {
                  const bl = personLabel(buyer);
                  return (
                    <TableRow
                      key={a.id}
                      tabIndex={0}
                      className={cn(
                        "cursor-pointer outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        a.counterpartWithdrawn && "shadow-[inset_4px_0_0_var(--destructive)]",
                      )}
                      aria-label={`Desk ${supplier.desk ?? "not set"}, ${supplier.name} with ${buyer.name}.${a.counterpartWithdrawn ? " Someone in this meeting withdrew." : ""} Open supplier`}
                      onClick={() => onSelect(supplier.id, a.slot)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        onSelect(supplier.id, a.slot);
                      }}
                    >
                      <TableCell className="pl-4">
                        <span className="inline-grid h-6 min-w-7 place-items-center rounded-sm bg-secondary px-1 font-display text-[13px] font-bold tabular-nums">
                          {supplier.desk ?? "–"}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-56">
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            title={TYPE_LABEL[supplier.type]}
                            className={cn("size-2 shrink-0 rounded-[2px]", typeDotClass(supplier.type))}
                          />
                          <span className="truncate font-semibold">{supplier.name}</span>
                        </span>
                      </TableCell>
                      <TableCell className="max-w-64">
                        <span className="block truncate">{bl.primary}</span>
                        {bl.secondary ? <span className="block truncate text-xs text-muted-foreground">{bl.secondary}</span> : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="inline-flex gap-1">
                          <RankBadge side="B" rank={a.buyerRank} topN={topN} />
                          <RankBadge side="S" rank={a.supplierRank} topN={topN} />
                        </span>
                      </TableCell>
                      <TableCell className="pr-4 max-sm:hidden">
                        <span className="inline-flex items-center gap-2 whitespace-nowrap">
                          <span
                            aria-hidden="true"
                            className={cn("h-3.5 w-6 shrink-0 rounded-[2px] p-0", treatmentClass(supplier.type, a.strength))}
                          />
                          {a.strength === "mutual" ? <MutualIcon /> : null}
                          {strengthLabel(a.strength, topN)}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {query || flagged ? "No desks match. Try a different name, or clear the filters." : `No meetings in slot ${current.slot}.`}
            </p>
          )}
        </section>
        <aside aria-labelledby="free-title" className="min-w-0 border-t bg-background/60 lg:border-t-0 lg:border-l">
          <div className="px-4 pt-4 pb-2">
            <h2 id="free-title" className="font-display text-lg font-bold">
              Free in slot {current.slot}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {allFree.length === 1 ? "1 buyer" : `${allFree.length} buyers`} without a meeting at {current.start}. Fewest
              meetings first.
            </p>
          </div>
          <ul className="flex flex-col px-2 pb-3">
            {freeBuyers.length ? (
              freeBuyers.map((b) => {
                const bl = personLabel(b);
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(b.id, current.slot)}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{bl.primary}</span>
                        {bl.secondary ? <span className="block truncate text-xs text-muted-foreground">{bl.secondary}</span> : null}
                      </span>
                      <span className="sr-only">{healthText(b, targets)}</span>
                      <CountChip count={b.count} health={healthOf(b, targets)} />
                    </button>
                  </li>
                );
              })
            ) : (
              <li className="px-2 py-3 text-sm text-muted-foreground">
                {query ? "No free buyer matches your search." : "Every buyer has a meeting in this slot."}
              </li>
            )}
          </ul>
          <Separator className="mx-4 w-auto" />
          <div className="px-4 py-3 text-sm">
            <h3 className="font-semibold">Supplier desks free</h3>
            <p className="mt-0.5 text-muted-foreground">
              {freeSuppliers.length
                ? freeSuppliers.map((s) => s.name).join(", ")
                : `None. All desks are booked in slot ${current.slot}, so filling a buyer's open slot here means a swap.`}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
