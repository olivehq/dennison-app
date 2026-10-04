import { isTopN } from './rankings';
import type { Appointment, CountAndPct, MatchInput, PersonCount, QualityStats } from './types';

type StatsInput = Pick<MatchInput, 'settings' | 'buyers' | 'suppliers'>;

/**
 * Sections A to G of the quality report, for any schedule. Ranks are read
 * from the appointment rows themselves (the same numbers the report prints),
 * so the server must set buyerRank and supplierRank on manual rows too.
 * Withdrawn people are excluded from the buyer and supplier totals.
 */
export function computeStats(appointments: Appointment[], input: StatsInput): QualityStats {
  const { settings } = input;
  const n = settings.mutualTopN;
  const cutoff = settings.hotelRankCutoff;
  const total = appointments.length;
  const pct = (count: number): CountAndPct => ({ count, pct: percent(count, total) });

  const buyers = input.buyers.filter((b) => !b.withdrawn).map((b) => b.id).sort();
  const suppliers = input.suppliers.filter((s) => !s.withdrawn).map((s) => s.id).sort();
  const buyerCounts = countBy(buyers, appointments, (a) => a.buyerId);
  const supplierCounts = countBy(suppliers, appointments, (a) => a.supplierId);

  const buyerDistribution: Record<number, number> = {};
  for (const count of buyerCounts.values()) {
    buyerDistribution[count] = (buyerDistribution[count] ?? 0) + 1;
  }

  let mutual = 0;
  let buyerOnly = 0;
  let supplierOnly = 0;
  let bothWithin2N = 0;
  let bothWithinCutoff = 0;
  let bothAboveCutoff = 0;
  let mixed = 0;
  let buyerBlank = 0;
  let supplierBlank = 0;
  let blank = 0;
  // A row with one rank blank still counts as "at least one side top N" when the other rank is.
  let blankOneSideTop = 0;

  for (const a of appointments) {
    const b = a.buyerRank;
    const s = a.supplierRank;
    if (b === null) buyerBlank++;
    if (s === null) supplierBlank++;
    if (b === null || s === null) {
      blank++;
      if (isTopN(b, n) || isTopN(s, n)) blankOneSideTop++;
      continue;
    }
    const bTop = isTopN(b, n);
    const sTop = isTopN(s, n);
    if (bTop && sTop) mutual++;
    else if (bTop) buyerOnly++;
    else if (sTop) supplierOnly++;
    else if (b <= 2 * n && s <= 2 * n) bothWithin2N++;
    else if (b > 2 * n && b <= cutoff && s > 2 * n && s <= cutoff) bothWithinCutoff++;
    else if (b > cutoff && s > cutoff) bothAboveCutoff++;
    else mixed++;
  }

  const suppliersAtTarget = [...supplierCounts.values()].filter((c) => c === settings.supplierTarget).length;
  const buyersInRange = [...buyerCounts.values()].filter(
    (c) => c >= settings.buyerMin && c <= settings.buyerMax,
  ).length;

  return {
    totalAppointments: total,
    totalBuyers: buyers.length,
    totalSuppliers: suppliers.length,
    buyerDistribution,
    suppliersAtTarget,
    supplierSuccessPct: percent(suppliersAtTarget, suppliers.length),
    buyersInRange,
    buyersInRangePct: percent(buyersInRange, buyers.length),
    mutualTopN: pct(mutual),
    oneSideTopN: { ...pct(buyerOnly + supplierOnly), buyerOnly, supplierOnly },
    neitherTopN: {
      ...pct(bothWithin2N + bothWithinCutoff + bothAboveCutoff + mixed),
      bothWithin2N,
      bothWithinCutoff,
      bothAboveCutoff,
      mixed,
    },
    blankRankings: { ...pct(blank), buyerBlank, supplierBlank },
    withBuyerRank: pct(total - buyerBlank),
    withSupplierRank: pct(total - supplierBlank),
    atLeastOneSideTopN: pct(mutual + buyerOnly + supplierOnly + blankOneSideTop),
    buyersBelowMin: offTarget(buyerCounts, (c) => c < settings.buyerMin),
    buyersAboveMax: offTarget(buyerCounts, (c) => c > settings.buyerMax),
    suppliersOffTarget: offTarget(supplierCounts, (c) => c !== settings.supplierTarget),
    thresholds: {
      mutualTopN: n,
      hotelRankCutoff: cutoff,
      supplierTarget: settings.supplierTarget,
      buyerMin: settings.buyerMin,
      buyerMax: settings.buyerMax,
    },
  };
}

/**
 * Count appointments per id. Every id in `ids` appears, with 0 when unused.
 * Rows for ids outside the list (withdrawn people) are not counted.
 */
function countBy(ids: string[], appointments: Appointment[], pick: (a: Appointment) => string) {
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const a of appointments) {
    const id = pick(a);
    const current = counts.get(id);
    if (current !== undefined) counts.set(id, current + 1);
  }
  return counts;
}

function offTarget(counts: Map<string, number>, test: (count: number) => boolean): PersonCount[] {
  return [...counts.entries()]
    .filter(([, count]) => test(count))
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.count - b.count || compareIds(a.id, b.id));
}

function percent(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
