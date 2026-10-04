import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';
import { defaultSettings } from './testing/synthetic';
import type { Appointment, Buyer, Supplier } from './types';

type Fixture = {
  event: { settings: Record<string, number> };
  suppliers: { name: string; type: 'business' | 'hotel' }[];
  buyers: { name: string }[];
  appointments: { slot: number; supplier: string; buyer: string; buyerRank: number | null; supplierRank: number | null }[];
};

/** fixtures/aw-2025-results.js assigns `window.AW_DATA = {...}`. */
function load2025(): Fixture {
  const source = readFileSync(resolve(process.cwd(), 'fixtures/aw-2025-results.js'), 'utf8');
  const json = source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1);
  return JSON.parse(json) as Fixture;
}

describe('computeStats against the real 2025 results', () => {
  const data = load2025();
  const buyers: Buyer[] = data.buyers.map((b) => ({ id: b.name, biztechOptIn: true }));
  const suppliers: Supplier[] = data.suppliers.map((s) => ({ id: s.name, type: s.type }));
  const appointments: Appointment[] = data.appointments.map((a) => ({
    slot: a.slot,
    buyerId: a.buyer,
    supplierId: a.supplier,
    buyerRank: a.buyerRank,
    supplierRank: a.supplierRank,
    source: 'engine',
    pinned: false,
  }));
  const settings = { ...defaultSettings, ...data.event.settings, slotCount: 9 };
  const stats = computeStats(appointments, { settings, buyers, suppliers });

  it('reproduces section A', () => {
    expect(stats.totalAppointments).toBe(504);
    expect(stats.totalBuyers).toBe(65);
    expect(stats.totalSuppliers).toBe(56);
    expect(stats.buyerDistribution).toEqual({ 5: 1, 6: 2, 7: 13, 8: 45, 9: 4 });
    expect(stats.suppliersAtTarget).toBe(56);
    expect(stats.supplierSuccessPct).toBe(100);
    expect(stats.buyersInRange).toBe(62);
  });

  it('reproduces sections B to E', () => {
    expect(stats.mutualTopN).toEqual({ count: 126, pct: 25 });
    expect(stats.oneSideTopN.count).toBe(330);
    expect(stats.oneSideTopN.buyerOnly).toBe(209);
    expect(stats.oneSideTopN.supplierOnly).toBe(121);
    expect(stats.neitherTopN).toEqual({
      count: 31,
      pct: 6.2,
      bothWithin2N: 1,
      bothWithinCutoff: 1,
      bothAboveCutoff: 4,
      mixed: 25,
    });
    expect(stats.blankRankings).toEqual({ count: 17, pct: 3.4, buyerBlank: 17, supplierBlank: 0 });
    expect(stats.withBuyerRank).toEqual({ count: 487, pct: 96.6 });
    expect(stats.withSupplierRank).toEqual({ count: 504, pct: 100 });
  });

  it('partitions every appointment into exactly one quality band', () => {
    const sum =
      stats.mutualTopN.count + stats.oneSideTopN.count + stats.neitherTopN.count + stats.blankRankings.count;
    expect(sum).toBe(stats.totalAppointments);
    expect(stats.atLeastOneSideTopN).toEqual({ count: 456, pct: 90.5 });
  });

  it('lists people off target with their counts', () => {
    expect(stats.buyersBelowMin.map((b) => b.count)).toEqual([5, 6, 6]);
    expect(stats.buyersAboveMax).toEqual([]);
    expect(stats.suppliersOffTarget).toEqual([]);
  });
});

describe('computeStats edge cases', () => {
  it('handles an empty schedule without dividing by zero', () => {
    const stats = computeStats([], { settings: defaultSettings, buyers: [{ id: 'b', biztechOptIn: true }], suppliers: [] });
    expect(stats.mutualTopN).toEqual({ count: 0, pct: 0 });
    expect(stats.buyerDistribution).toEqual({ 0: 1 });
    expect(stats.buyersBelowMin).toEqual([{ id: 'b', count: 0 }]);
  });

  it('excludes withdrawn people from totals and does not count their rows', () => {
    const stats = computeStats(
      [{ slot: 1, buyerId: 'gone', supplierId: 's', buyerRank: 1, supplierRank: 1, source: 'engine', pinned: false }],
      {
        settings: defaultSettings,
        buyers: [{ id: 'gone', biztechOptIn: true, withdrawn: true }, { id: 'b', biztechOptIn: true }],
        suppliers: [{ id: 's', type: 'hotel' }],
      },
    );
    expect(stats.totalBuyers).toBe(1);
    expect(stats.buyerDistribution).toEqual({ 0: 1 });
    expect(stats.suppliersOffTarget).toEqual([{ id: 's', count: 1 }]);
  });
});
