import { describe, expect, it } from 'vitest';
import { repairSchedule, runMatching } from './match';
import { buildRankingIndex } from './rankings';
import { defaultSettings, mulberry32, shuffle, syntheticEvent } from './testing/synthetic';
import type { Appointment, Buyer, MatchInput, Ranking, Supplier } from './types';
import { findConflicts } from './validate';

/** Several shapes of event, all with enough buyers for every supplier to fill. */
const propertyCases = [
  { seed: 1, buyers: 65, business: 9, hotels: 47 },
  { seed: 2, buyers: 40, business: 5, hotels: 25 },
  { seed: 3, buyers: 70, business: 12, hotels: 40, optOutShare: 0.5, rejectionsPerBuyer: 5 },
  { seed: 4, buyers: 30, business: 3, hotels: 17, supplierBlankShare: 0.6 },
  { seed: 5, buyers: 65, business: 9, hotels: 47, noise: 0.5 },
  { seed: 6, buyers: 20, business: 2, hotels: 8, settings: { slotCount: 5, supplierTarget: 5, buyerMin: 2, buyerMax: 4, buyerIdeal: 3 } },
];

describe('runMatching hard constraints', () => {
  for (const options of propertyCases) {
    const input = syntheticEvent(options);
    const { appointments, stats, warnings } = runMatching(input);
    const index = buildRankingIndex(input.rankings);
    const byId = {
      buyer: new Map(input.buyers.map((b) => [b.id, b])),
      supplier: new Map(input.suppliers.map((s) => [s.id, s])),
    };

    describe(`seed ${options.seed}, ${options.buyers} buyers x ${options.business + options.hotels} suppliers`, () => {
      it('has no double booking and no duplicate pair', () => {
        expect(findConflicts(appointments)).toEqual([]);
      });

      it('never matches a rejected pair', () => {
        expect(appointments.some((a) => index.isRejected(a.buyerId, a.supplierId))).toBe(false);
      });

      it('never matches an opted-out buyer with a business supplier (D1)', () => {
        const bad = appointments.filter(
          (a) => byId.supplier.get(a.supplierId)!.type === 'business' && !byId.buyer.get(a.buyerId)!.biztechOptIn,
        );
        expect(bad).toEqual([]);
      });

      it('puts every supplier at target when capacity allows', () => {
        expect(stats.suppliersAtTarget).toBe(input.suppliers.length);
        expect(warnings.filter((w) => w.startsWith('Supplier'))).toEqual([]);
      });

      it('keeps every buyer at or below buyerMax and every slot in range', () => {
        expect(stats.buyersAboveMax).toEqual([]);
        for (const a of appointments) {
          expect(a.slot).toBeGreaterThanOrEqual(1);
          expect(a.slot).toBeLessThanOrEqual(input.settings.slotCount);
        }
      });

      it('stamps each row with the ranks from the rankings', () => {
        for (const a of appointments) {
          expect(a.buyerRank).toBe(index.buyerRank(a.buyerId, a.supplierId));
          expect(a.supplierRank).toBe(index.supplierRank(a.supplierId, a.buyerId));
          expect(a.source).toBe('engine');
          expect(a.pinned).toBe(false);
        }
      });
    });
  }
});

describe('runMatching determinism', () => {
  const input = syntheticEvent({ seed: 11, buyers: 65, business: 9, hotels: 47 });

  it('returns the same result twice', () => {
    expect(runMatching(input)).toEqual(runMatching(input));
  });

  it('returns the same result when the input arrays are shuffled', () => {
    const rand = mulberry32(99);
    const shuffled: MatchInput = {
      ...input,
      buyers: shuffle(input.buyers, rand),
      suppliers: shuffle(input.suppliers, rand),
      rankings: shuffle(input.rankings, rand),
    };
    expect(runMatching(shuffled).appointments).toEqual(runMatching(input).appointments);
  });
});

describe('runMatching on a realistic 65 x 56 event', () => {
  const input = syntheticEvent({ seed: 2026, buyers: 65, business: 9, hotels: 47 });

  it('meets the 2025 quality bar in well under 200 ms', () => {
    const started = performance.now();
    const { stats } = runMatching(input);
    const elapsed = performance.now() - started;

    const buyersAt7to9 = Object.entries(stats.buyerDistribution)
      .filter(([count]) => Number(count) >= 7 && Number(count) <= 9)
      .reduce((sum, [, buyers]) => sum + buyers, 0);

    expect(stats.totalAppointments).toBe(504);
    expect(stats.suppliersAtTarget).toBe(56);
    expect(buyersAt7to9 / 65).toBeGreaterThanOrEqual(0.85);
    expect(stats.mutualTopN.pct).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('runMatching pinned appointments', () => {
  const input = syntheticEvent({ seed: 7, buyers: 65, business: 9, hotels: 47 });
  const first = runMatching(input);

  it('keeps pinned rows exactly as given and fills around them', () => {
    const pinned = first.appointments
      .filter((_, i) => i % 7 === 0)
      .map((a) => ({ ...a, source: 'manual' as const, pinned: true }));
    const second = runMatching({ ...input, pinned });

    for (const row of pinned) expect(second.appointments).toContainEqual(row);
    expect(findConflicts(second.appointments)).toEqual([]);
    expect(second.stats.suppliersAtTarget).toBe(56);
  });

  it('drops a pinned row that names a withdrawn person, with a warning', () => {
    const victim = first.appointments[0];
    const buyers = input.buyers.map((b) => (b.id === victim.buyerId ? { ...b, withdrawn: true } : b));
    const result = runMatching({ ...input, buyers, pinned: [{ ...victim, pinned: true }] });
    expect(result.appointments.some((a) => a.buyerId === victim.buyerId)).toBe(false);
    expect(result.warnings.some((w) => w.startsWith('Dropped pinned appointment'))).toBe(true);
  });

  it('drops the later of two pinned rows that double book, with a warning', () => {
    const [a, b] = first.appointments.filter((x) => x.slot === 1).slice(0, 2);
    const clash: Appointment = { ...b, buyerId: a.buyerId, pinned: true };
    const result = runMatching({ ...input, pinned: [{ ...a, pinned: true }, clash] });
    expect(findConflicts(result.appointments)).toEqual([]);
    expect(result.appointments).toContainEqual({ ...a, pinned: true });
    expect(result.warnings.filter((w) => w.includes('conflicts with another pinned'))).toHaveLength(1);
  });
});

describe('runMatching after a withdrawal', () => {
  const input = syntheticEvent({ seed: 8, buyers: 65, business: 9, hotels: 47 });
  const active = runMatching(input);
  const gone = active.appointments[100].buyerId;

  it('leaves gaps for the withdrawn buyer and a re-run with pinned rows fills only those gaps', () => {
    const gaps = active.appointments.filter((a) => a.buyerId === gone);
    expect(gaps.length).toBeGreaterThan(0);

    // D10: pin everything that does not involve the withdrawn person.
    const kept = active.appointments.filter((a) => a.buyerId !== gone).map((a) => ({ ...a, pinned: true }));
    const buyers = input.buyers.map((b) => (b.id === gone ? { ...b, withdrawn: true } : b));
    const rerun = runMatching({ ...input, buyers, pinned: kept });

    expect(rerun.appointments.some((a) => a.buyerId === gone)).toBe(false);
    for (const row of kept) expect(rerun.appointments).toContainEqual(row);

    const added = rerun.appointments.filter((a) => !a.pinned);
    expect(added).toHaveLength(gaps.length);
    const gapSlots = new Set(gaps.map((g) => `${g.slot}|${g.supplierId}`));
    for (const a of added) expect(gapSlots.has(`${a.slot}|${a.supplierId}`)).toBe(true);
    expect(rerun.stats.suppliersAtTarget).toBe(56);
    expect(findConflicts(rerun.appointments)).toEqual([]);
  });
});

/** Tiny hand-built events for rule-level tests. */
const tiny = (
  buyers: Buyer[],
  suppliers: Supplier[],
  ranks: Array<[buyerId: string, supplierId: string, buyerRank: number | null, supplierRank: number | null]>,
  settings: Partial<MatchInput['settings']> = {},
): MatchInput => {
  const rankings: Ranking[] = [];
  for (const [b, s, br, sr] of ranks) {
    rankings.push({ rankerType: 'buyer', rankerId: b, targetType: 'supplier', targetId: s, rank: br, isRejection: false });
    if (sr !== null) {
      rankings.push({ rankerType: 'supplier', rankerId: s, targetType: 'buyer', targetId: b, rank: sr, isRejection: false });
    }
  }
  return { settings: { ...defaultSettings, ...settings }, buyers, suppliers, rankings, pinned: [] };
};

const b = (id: string, biztechOptIn = true): Buyer => ({ id, biztechOptIn });

describe('runMatching rule details', () => {
  it('hotels skip buyer ranks above hotelRankCutoff in pass B; business suppliers do not', () => {
    // X: buyer 30 / supplier 1. Y: buyer 20 / blank. Z: buyer 28 / supplier 5.
    const ranks: Parameters<typeof tiny>[2] = [
      ['X', 'S', 30, 1],
      ['Y', 'S', 20, null],
      ['Z', 'S', 28, 5],
    ];
    const settings = { slotCount: 2, supplierTarget: 2, buyerMin: 0, buyerMax: 2, buyerIdeal: 1 };
    const hotel = runMatching(tiny([b('X'), b('Y'), b('Z')], [{ id: 'S', type: 'hotel' }], ranks, settings));
    const business = runMatching(tiny([b('X'), b('Y'), b('Z')], [{ id: 'S', type: 'business' }], ranks, settings));
    // Hotel: pass B only sees Y, then pass C takes the better buyer rank, Z.
    expect(hotel.appointments.map((a) => a.buyerId).sort()).toEqual(['Y', 'Z']);
    // Business: Y by buyer rank, then X by supplier rank.
    expect(business.appointments.map((a) => a.buyerId).sort()).toEqual(['X', 'Y']);
  });

  it('places mutual top-N pairs before better one-sided ranks', () => {
    const input = tiny(
      [b('M'), b('O')],
      [{ id: 'S', type: 'hotel' }],
      [
        ['M', 'S', 10, 10],
        ['O', 'S', 1, 11],
      ],
      { slotCount: 1, supplierTarget: 1, buyerMin: 0, buyerMax: 1, buyerIdeal: 1 },
    );
    expect(runMatching(input).appointments.map((a) => a.buyerId)).toEqual(['M']);
  });

  it('matches opted-out buyers with business suppliers under all_opted_in', () => {
    const input = tiny([b('X', false)], [{ id: 'S', type: 'business' }], [['X', 'S', 1, 1]], {
      slotCount: 1,
      supplierTarget: 1,
      buyerMin: 0,
      buyerMax: 1,
      buyerIdeal: 1,
      biztechOptInRule: 'all_opted_in',
    });
    expect(runMatching(input).appointments).toHaveLength(1);
    expect(runMatching({ ...input, settings: { ...input.settings, biztechOptInRule: 'from_biztech_file' } }).appointments).toHaveLength(0);
  });

  it('warns when a supplier cannot reach target', () => {
    const input = tiny([b('X'), b('Y')], [{ id: 'S', type: 'hotel' }], [], {
      slotCount: 3,
      supplierTarget: 3,
      buyerMin: 0,
      buyerMax: 3,
      buyerIdeal: 2,
    });
    const result = runMatching(input);
    expect(result.appointments).toHaveLength(2);
    expect(result.warnings).toEqual(['Supplier S filled only 2 of 3']);
    expect(result.stats.suppliersOffTarget).toEqual([{ id: 'S', count: 2 }]);
  });

  it('warns about buyers below buyerMin', () => {
    const input = tiny([b('X'), b('Y')], [{ id: 'S', type: 'hotel' }], [], {
      slotCount: 1,
      supplierTarget: 1,
      buyerMin: 1,
      buyerMax: 1,
      buyerIdeal: 1,
    });
    expect(runMatching(input).warnings).toEqual(['Buyer Y has 0 appointments (min 1)']);
  });
});

describe('repair pass', () => {
  const settings = { slotCount: 2, supplierTarget: 1, buyerMin: 1, buyerMax: 2, buyerIdeal: 1 };
  const suppliers: Supplier[] = [{ id: 'S1', type: 'hotel' }, { id: 'S2', type: 'hotel' }];
  const row = (slot: number, buyerId: string, supplierId: string, pinned = false): Appointment => ({
    slot,
    buyerId,
    supplierId,
    buyerRank: null,
    supplierRank: null,
    source: 'engine',
    pinned,
  });

  it('moves an appointment from a buyer at buyerMax to a buyer below buyerMin', () => {
    const input = tiny([b('A'), b('D')], suppliers, [['A', 'S1', 1, 1], ['A', 'S2', 2, 9], ['D', 'S2', 3, 2]], settings);
    const result = repairSchedule([row(1, 'A', 'S1'), row(2, 'A', 'S2')], input);
    // A valued S2 least (combined 11 vs 2), so that meeting moves to D, free in slot 2.
    // The untouched row is echoed as given; the moved row gets ranks from the rankings.
    expect(result.appointments).toEqual([row(1, 'A', 'S1'), { ...row(2, 'D', 'S2'), buyerRank: 3, supplierRank: 2 }]);
    expect(result.warnings).toEqual([]);
  });

  it('never moves a pinned row', () => {
    const input = tiny([b('A'), b('D')], suppliers, [], settings);
    const result = repairSchedule([row(1, 'A', 'S1', true), row(2, 'A', 'S2', true)], input);
    expect(result.appointments.map((a) => a.buyerId)).toEqual(['A', 'A']);
    expect(result.warnings).toEqual(['Buyer D has 0 appointments (min 1)']);
  });

  it('never moves to a buyer who rejected the supplier or is busy in that slot', () => {
    const input = tiny([b('A'), b('D')], suppliers, [], settings);
    input.rankings.push({ rankerType: 'buyer', rankerId: 'D', targetType: 'supplier', targetId: 'S1', rank: null, isRejection: true });
    // D rejected S1 and the S2 row is pinned, so nothing can move.
    const result = repairSchedule([row(1, 'A', 'S1'), row(2, 'A', 'S2', true)], input);
    expect(result.appointments.filter((a) => a.buyerId === 'D')).toEqual([]);
  });

  it('never drops the donor below buyerMin', () => {
    const tight = { ...settings, buyerMin: 2, buyerMax: 2 };
    const input = tiny([b('A'), b('D')], suppliers, [], tight);
    const result = repairSchedule([row(1, 'A', 'S1'), row(2, 'A', 'S2')], input);
    expect(result.appointments.map((a) => a.buyerId)).toEqual(['A', 'A']);
  });

  it('runs inside runMatching and rescues a buyer the greedy fill left empty', () => {
    // A, B, C, E are mutual top-10 with every supplier and absorb all six slots. D ranked nobody.
    const ranks: Parameters<typeof tiny>[2] = [];
    for (const s of ['S1', 'S2', 'S3']) for (const [i, buyer] of ['A', 'B', 'C', 'E'].entries()) ranks.push([buyer, s, i + 1, i + 1]);
    const input = tiny(
      [b('A'), b('B'), b('C'), b('D'), b('E')],
      [{ id: 'S1', type: 'hotel' }, { id: 'S2', type: 'hotel' }, { id: 'S3', type: 'hotel' }],
      ranks,
      { slotCount: 2, supplierTarget: 2, buyerMin: 1, buyerMax: 2, buyerIdeal: 2 },
    );
    const countFor = (rows: Appointment[], id: string) => rows.filter((a) => a.buyerId === id).length;

    // With buyerMin 0 the repair pass has nothing to do, which shows the greedy fill alone leaves D empty.
    const greedyOnly = runMatching({ ...input, settings: { ...input.settings, buyerMin: 0 } });
    expect(countFor(greedyOnly.appointments, 'D')).toBe(0);

    const repaired = runMatching(input);
    expect(countFor(repaired.appointments, 'D')).toBe(1);
    expect(repaired.stats.buyersBelowMin).toEqual([]);
    expect(repaired.stats.buyersAboveMax).toEqual([]);
    expect(repaired.stats.suppliersAtTarget).toBe(3);
    expect(findConflicts(repaired.appointments)).toEqual([]);
    expect(repaired.warnings).toEqual([]);
  });
});
