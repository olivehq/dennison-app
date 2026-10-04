"use client";

import * as React from "react";
import { ArrowRightIcon } from "lucide-react";
import { MutualIcon, strengthLabel } from "@/components/app/appointment-block";
import { RankBadge } from "@/components/app/rank-badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import type { ActionResult } from "@/lib/errors";
import { swapCandidatesAction } from "@/server/schedule/actions";
import type { SwapCandidate } from "@/server/schedule/edits";

/** Which supplier slot the picker fills. `removeBuyerId` set means replace, else add. */
export type PickerRequest = {
  supplierId: string;
  supplierName: string;
  slot: number;
  slotLabel: string;
  removeBuyerId?: string;
  removeBuyerName?: string;
};

export function pickerTitle(request: PickerRequest): string {
  return request.removeBuyerId
    ? `Replace ${request.removeBuyerName ?? "this buyer"}`
    : `Add a buyer to ${request.supplierName}`;
}

export function pickerDescription(request: PickerRequest): string {
  return `${request.supplierName}, slot ${request.slot}, ${request.slotLabel}. Buyers free in this slot who are not already meeting this supplier and are eligible, best combined rank first.`;
}

type Loaded = { key: string; result: ActionResult<SwapCandidate[]> };

function requestKey(runId: string, version: number, r: PickerRequest): string {
  return [runId, version, r.supplierId, r.slot, r.removeBuyerId ?? ""].join(":");
}

/**
 * The ranked buyer list for one supplier slot, fed by `swapCandidatesAction`.
 * Rendered inside a Dialog on desktop and inside the detail Sheet on mobile.
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

  React.useEffect(() => {
    let cancelled = false;
    swapCandidatesAction({
      runId,
      supplierId: request.supplierId,
      slot: request.slot,
      excludeBuyerId: request.removeBuyerId,
    }).then(
      (result) => {
        if (!cancelled) setLoaded({ key, result });
      },
      () => {
        if (!cancelled) {
          setLoaded({ key, result: { ok: false, error: { code: "internal", message: "Could not load buyers. Try again." } } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, runId, request.supplierId, request.slot, request.removeBuyerId]);

  const current = loaded?.key === key ? loaded.result : null;

  return (
    <Command className="h-auto rounded-lg! border" aria-busy={pending || current === null}>
      <CommandInput placeholder="Search buyer or organization" disabled={pending} />
      <CommandList className="max-h-[min(60dvh,420px)]">
        {current === null ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> Finding buyers who are free
          </div>
        ) : !current.ok ? (
          <p className="px-3 py-6 text-center text-sm text-destructive">{current.error.message}</p>
        ) : (
          <>
            <CommandEmpty>
              {current.data.length ? "No buyer matches that." : "No buyer is free and eligible for this slot."}
            </CommandEmpty>
            <CommandGroup heading={`${current.data.length} ${current.data.length === 1 ? "buyer" : "buyers"} can take this slot`}>
              {current.data.map((c) => (
                <CommandItem
                  key={c.buyerId}
                  value={`${c.name} ${c.organization ?? ""} ${c.title ?? ""} ${c.buyerId}`}
                  disabled={pending}
                  onSelect={() => onPick(c)}
                  className="items-start gap-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold break-words">{c.name}</span>
                    {c.organization && !c.name.includes(c.organization) ? (
                      <span className="block text-xs text-muted-foreground">{c.organization}</span>
                    ) : null}
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
