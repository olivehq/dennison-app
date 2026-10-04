"use client";

import * as React from "react";
import { AlertTriangleIcon, PencilLineIcon } from "lucide-react";
import { cn } from "cn";
import { MutualIcon, TYPE_LABEL } from "@/components/app/appointment-block";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { QualityStats } from "@/engine";
import type { ScheduleAppointment, ScheduleSlot } from "@/server/schedule/queries";
import { CountChip } from "./count-chip";
import {
  appointmentsOf,
  distribution,
  healthOf,
  personLabel,
  personMatches,
  type Person,
  type ScheduleModel,
  type Targets,
} from "./schedule-model";

type QualityViewProps = {
  stats: QualityStats | null;
  warnings: string[];
  model: ScheduleModel;
  slots: ScheduleSlot[];
  appointments: ScheduleAppointment[];
  targets: Targets & { buyerIdeal: number };
  query: string;
  onSelect: (personId: string) => void;
};

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export function QualityView({ stats, warnings, model, slots, appointments, targets, query, onSelect }: QualityViewProps) {
  const manual = appointments.filter((a) => a.source === "manual").length;
  const filter = (list: Person[]) => (query ? list.filter((p) => personMatches(p, query)) : list);
  const below = model.buyers.filter((b) => healthOf(b, targets) === "under").sort((a, b) => a.count - b.count);
  const above = model.buyers.filter((b) => healthOf(b, targets) === "over").sort((a, b) => b.count - a.count);
  const offSuppliers = model.suppliers.filter((s) => healthOf(s, targets) !== "ok");

  if (!stats) {
    return (
      <Alert>
        <AlertTriangleIcon />
        <AlertTitle>No numbers for this run</AlertTitle>
        <AlertDescription>The active run has no stored stats. Run matching again to compute them.</AlertDescription>
      </Alert>
    );
  }

  const total = stats.totalAppointments;
  const dist = distribution(stats.buyerDistribution, targets);
  const maxBuyers = Math.max(1, ...dist.map((d) => d.buyers));
  const n = stats.thresholds.mutualTopN;
  const breakdown = [
    { label: `Mutual top ${n}`, count: stats.mutualTopN.count, icon: true },
    { label: `Buyer's top ${n} only`, count: stats.oneSideTopN.buyerOnly },
    { label: `Supplier's top ${n} only`, count: stats.oneSideTopN.supplierOnly },
    { label: `Neither, both ranked ${n + 1} to ${2 * n}`, count: stats.neitherTopN.bothWithin2N },
    {
      label: `Neither, both ranked ${2 * n + 1} to ${stats.thresholds.hotelRankCutoff}`,
      count: stats.neitherTopN.bothWithinCutoff,
    },
    { label: `Neither, both ranked above ${stats.thresholds.hotelRankCutoff}`, count: stats.neitherTopN.bothAboveCutoff },
    { label: "Neither, mixed ranks", count: stats.neitherTopN.mixed },
    {
      label: `Blank, ${stats.blankRankings.buyerBlank} by buyers, ${stats.blankRankings.supplierBlank} by suppliers`,
      count: stats.blankRankings.count,
    },
  ];

  const verdict =
    `${total} appointments over ${slots.length} slots. ` +
    (stats.suppliersAtTarget === stats.totalSuppliers
      ? `Every supplier has ${targets.supplierTarget}. `
      : `${stats.suppliersAtTarget} of ${stats.totalSuppliers} suppliers have ${targets.supplierTarget}. `) +
    `${stats.buyersInRange} of ${stats.totalBuyers} buyers are within ${targets.buyerMin} to ${targets.buyerMax}` +
    (below.length + above.length ? `; ${below.length + above.length} need attention.` : ".");

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-8">
        <p className="max-w-[62ch] font-display text-xl leading-snug font-semibold text-balance sm:text-[22px]">{verdict}</p>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Appointments" value={total} sub={`${slots.length} slots, ${stats.totalSuppliers} desks`} />
          <StatCard
            label={`Suppliers at ${targets.supplierTarget}`}
            value={stats.suppliersAtTarget}
            of={stats.totalSuppliers}
            sub={`${stats.supplierSuccessPct}% on target`}
          />
          <StatCard
            label={`Buyers at ${targets.buyerMin} to ${targets.buyerMax}`}
            value={stats.buyersInRange}
            of={stats.totalBuyers}
            sub={`${below.length} below, ${above.length} above`}
          />
          <StatCard label={`Mutual top ${n}`} value={stats.mutualTopN.count} sub={`${stats.mutualTopN.pct}% of appointments`} />
        </div>

        <section aria-labelledby="q-dist" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="q-dist" className="font-display text-lg font-bold">
              Meetings per buyer
            </h2>
            <p className="text-sm text-muted-foreground">
              Shaded columns are the target range, {targets.buyerMin} to {targets.buyerMax}. Ideal is {targets.buyerIdeal}.
            </p>
          </div>
          <div
            role="img"
            aria-label={dist.map((d) => `${d.buyers} ${d.buyers === 1 ? "buyer" : "buyers"} with ${d.count}`).join(", ")}
            className="flex h-56 items-stretch border-b"
          >
            {dist.map((d) => (
              <div
                key={d.count}
                className={cn(
                  "flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5 px-1 pt-2.5",
                  d.inRange && "bg-hotel-tint/55",
                )}
              >
                <span className="text-sm font-bold tabular-nums">{d.buyers}</span>
                <div
                  className={cn("w-[min(56px,70%)] rounded-t-[3px]", d.inRange ? "bg-chart-3" : "bg-destructive")}
                  style={{ height: `${(d.buyers / maxBuyers) * 150}px` }}
                />
              </div>
            ))}
          </div>
          <div className="flex" aria-hidden="true">
            {dist.map((d) => (
              <div key={d.count} className="flex-1 text-center text-sm tabular-nums">
                <span className="font-semibold">{d.count}</span>
                {d.count === targets.buyerIdeal ? <span className="text-muted-foreground max-sm:hidden"> ideal</span> : null}
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="q-match" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="q-match" className="font-display text-lg font-bold">
              Match strength
            </h2>
            <p className="text-sm text-muted-foreground">Did both sides want this meeting?</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>How they ranked each other</TableHead>
                <TableHead className="text-right">Meetings</TableHead>
                <TableHead className="text-right">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="whitespace-normal">
                    <span className="inline-flex items-center gap-1.5">
                      {row.icon ? <MutualIcon /> : null}
                      {row.label}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{row.count}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{pct(row.count, total)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        {warnings.length ? (
          <section aria-labelledby="q-warn" className="flex flex-col gap-2">
            <h2 id="q-warn" className="font-display text-lg font-bold">
              Run warnings
            </h2>
            <ul className="flex max-w-[72ch] list-disc flex-col gap-1 pl-5 text-sm">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <aside className="flex flex-col gap-4" aria-labelledby="q-attn">
        <Card>
          <CardHeader>
            <CardTitle id="q-attn" className="font-display text-lg font-bold">
              Needs attention
            </CardTitle>
            {query ? <CardDescription>Filtered by &ldquo;{query}&rdquo;</CardDescription> : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <PeopleList
              title={`Below ${targets.buyerMin}`}
              people={filter(below)}
              empty={below.length ? "None match your search." : `No buyer has fewer than ${targets.buyerMin}.`}
              why={(p) => {
                const open = slots.filter((s) => !appointmentsOf(model, p.id).has(s.slot)).map((s) => s.slot);
                return open.length ? `Open in slots ${open.join(", ")}` : "No open slots";
              }}
              targets={targets}
              onSelect={onSelect}
            />
            <Separator />
            <PeopleList
              title={`Above ${targets.buyerMax}`}
              people={filter(above)}
              empty={above.length ? "None match your search." : `No buyer has more than ${targets.buyerMax}.`}
              why={(p) => `${p.count - targets.buyerMax} over the maximum`}
              targets={targets}
              onSelect={onSelect}
            />
            <Separator />
            <PeopleList
              title={`Suppliers not at ${targets.supplierTarget}`}
              people={filter(offSuppliers)}
              empty={
                offSuppliers.length
                  ? "None match your search."
                  : `All ${model.suppliers.length} suppliers have exactly ${targets.supplierTarget}.`
              }
              why={(p) => (p.kind === "supplier" ? `${TYPE_LABEL[p.type]}, desk ${p.desk ?? "not set"}` : "")}
              targets={targets}
              onSelect={onSelect}
            />
          </CardContent>
        </Card>
        <Alert>
          <PencilLineIcon />
          <AlertTitle>{manual === 1 ? "1 manual change" : `${manual} manual changes`}</AlertTitle>
          <AlertDescription>
            Appointments placed by hand on top of the engine&apos;s result. Running matching without keeping existing
            appointments would replace them.
          </AlertDescription>
        </Alert>
      </aside>
    </div>
  );
}

function StatCard({ label, value, of, sub }: { label: string; value: number; of?: number; sub: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="font-display text-3xl font-bold tabular-nums">
          {value}
          {of !== undefined ? <span className="text-base font-semibold text-muted-foreground">/{of}</span> : null}
        </CardTitle>
        <CardDescription className="text-xs">{sub}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function PeopleList({
  title,
  people,
  empty,
  why,
  targets,
  onSelect,
}: {
  title: string;
  people: Person[];
  empty: string;
  why: (p: Person) => string;
  targets: Targets;
  onSelect: (personId: string) => void;
}) {
  return (
    <div>
      <h3 className="px-2 text-sm font-semibold">{title}</h3>
      <ul className="mt-1 flex flex-col">
        {people.length ? (
          people.map((p) => {
            const label = personLabel(p);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelect(p.id)}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CountChip count={p.count} health={healthOf(p, targets)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{label.primary}</span>
                    {label.secondary ? (
                      <span className="block truncate text-xs text-muted-foreground">{label.secondary}</span>
                    ) : null}
                    <span className="block text-xs text-muted-foreground">{why(p)}</span>
                  </span>
                </button>
              </li>
            );
          })
        ) : (
          <li className="px-2 py-2 text-sm text-muted-foreground">{empty}</li>
        )}
      </ul>
    </div>
  );
}
