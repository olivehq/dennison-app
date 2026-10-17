"use client";

import * as React from "react";
import { ArrowRightIcon } from "lucide-react";
import { cn } from "cn";
import { MutualIcon, strengthLabel, TYPE_LABEL, typeDotClass } from "@/components/app/appointment-block";
import { RankBadge } from "@/components/app/rank-badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import type { ActionResult } from "@/lib/errors";
import { swapCandidatesAction } from "@/server/schedule/actions";
import type { SwapCandidate } from "@/server/schedule/edits";
import { candidateCountLine, candidateFields, matchesSearch } from "./schedule-model";

/**
 * Which slot the picker fills. `pick: "buyer"` lists buyers for a supplier's
 * slot (`removeBuyerId` set means replace, else add); `pick: "supplier"` lists
 * suppliers for a buyer's open slot. `ownerId` is the person whose sheet
 * opened it: on a buyer's sheet, Replace opens a buyer picker for the
 * counterpart supplier, so the owner is not always the supplier or buyer here.
 */
export type PickerRequest =
  | {
      pick: "buyer";
      ownerId: string;
      supplierId: string;
      supplierName: string;
      slot: number;
      slotLabel: string;
      removeBuyerId?: string;
      removeBuyerName?: string;
    }
  | {
      pick: "supplier";
      ownerId: string;
      buyerId: string;
      buyerName: string;
      slot: number;
      slotLabel: string;
    };

export function pickerTitle(request: PickerRequest): string {
  if (request.pick === "supplier") return `Add a supplier to ${request.buyerName}`;
  return request.removeBuyerId
    ? `Replace ${request.removeBuyerName ?? "this buyer"} at ${request.supplierName}`
    : `Add a buyer to ${request.supplierName}`;
}

export function pickerDescription(request: PickerRequest): string {
  if (request.pick === "supplier") {
    return `${request.buyerName}, slot ${request.slot}, ${request.slotLabel}. Suppliers free in this slot who are not already meeting this buyer and are eligible, best combined rank first.`;
  }
  return `${request.supplierName}, slot ${request.slot}, ${request.slotLabel}. Buyers free in this slot who are not already meeting this supplier and are eligible, best combined rank first.`;
}

type Loaded = { key: string; result: ActionResult<SwapCandidate[]> };

function requestKey(runId: string, version: number, r: PickerRequest): string {
  return r.pick === "supplier"
    ? [runId, version, "supplier", r.buyerId, r.slot].join(":")
    : [runId, version, "buyer", r.supplierId, r.slot, r.removeBuyerId ?? ""].join(":");
}

/**
 * The ranked list for one slot, fed by `swapCandidatesAction`: buyers for a
 * supplier's slot, or suppliers for a buyer's slot. Rendered inside a Dialog
 * on desktop and inside the detail Sheet on mobile.
 */
export function SwapPicker({
  request,
  runId,
  version,
  topN,
  pending,
  onPick,
}: {
  request: PickerRequest;
  runId: string;
  version: number;
  topN: number;
  pending: boolean;
  onPick: (candidate: SwapCandidate) => void;
}) {
  const key = requestKey(runId, version, request);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const pickSide = request.pick;
  const slot = request.slot;
  const ownerId = request.pick === "supplier" ? request.buyerId : request.supplierId;
  const removeBuyerId = request.pick === "buyer" ? request.removeBuyerId : undefined;

  React.useEffect(() => {
    let cancelled = false;
    swapCandidatesAction(
      pickSide === "supplier"
        ? { runId, buyerId: ownerId, slot }
        : { runId, supplierId: ownerId, slot, excludeBuyerId: removeBuyerId },
    ).then(
      (result) => {
        if (!cancelled) setLoaded({ key, result });
      },
      () => {
        if (!cancelled) {
          setLoaded({ key, result: { ok: false, error: { code: "internal", message: "Could not load the list. Try again." } } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, runId, pickSide, ownerId, slot, removeBuyerId]);

  const current = loaded?.key === key ? loaded.result : null;
  const noun = request.pick;
  // Tied to the request, so a new picker starts with an empty search.
  const [typed, setTyped] = React.useState({ key, value: "" });
  const search = typed.key === key ? typed.value : "";
  const setSearch = (value: string) => setTyped({ key, value });
  const searching = search.trim() !== "";
  const shown = current?.ok ? current.data.filter((c) => matchesSearch(search, candidateFields(c))) : [];

  return (
    <Command className="h-auto rounded-lg! border" aria-busy={pending || current === null} shouldFilter={false}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={noun === "buyer" ? "Search buyer or organization" : "Search supplier"}
        disabled={pending}
      />
      <CommandList className="max-h-[min(60dvh,420px)]">
        {current === null ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> Finding {noun}s who are free
          </div>
        ) : !current.ok ? (
          <p className="px-3 py-6 text-center text-sm text-destructive">{current.error.message}</p>
        ) : (
          <>
            <CommandEmpty>
              {current.data.length
                ? `No ${noun} matches “${search.trim()}”. Check the spelling or clear the search.`
                : `No ${noun} is free and eligible for this slot.`}
            </CommandEmpty>
            <CommandGroup heading={candidateCountLine(noun, shown.length, current.data.length, searching)}>
              {shown.map((c) => (
                <CommandItem
                  key={c.kind === "buyer" ? c.buyerId : c.supplierId}
                  value={c.kind === "buyer" ? c.buyerId : c.supplierId}
                  disabled={pending}
                  onSelect={() => onPick(c)}
                  className="items-start gap-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold break-words">{c.name}</span>
                    {c.kind === "buyer" ? (
                      c.organization && !c.name.includes(c.organization) ? (
                        <span className="block text-xs text-muted-foreground">{c.organization}</span>
                      ) : null
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span aria-hidden="true" className={cn("size-2 rounded-[2px]", typeDotClass(c.supplierType))} />
                        {TYPE_LABEL[c.supplierType]}
                        {c.desk !== null ? `, desk ${c.desk}` : null}
                      </span>
                    )}
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <RankBadge side="B" rank={c.buyerRank} topN={topN} />
                      <RankBadge side="S" rank={c.supplierRank} topN={topN} />
                      <span className="inline-flex items-center gap-1">
                        {c.strength === "mutual" ? <MutualIcon /> : null}
                        {strengthLabel(c.strength, topN)}
                      </span>
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 pt-0.5 text-xs tabular-nums">
                    <span className="sr-only">Count goes from</span>
                    <span className="text-muted-foreground">count</span> {c.count}
                    <ArrowRightIcon aria-hidden="true" className="size-3" />
                    <span className="sr-only">to</span>
                    <span className="font-semibold">{c.countAfter}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
