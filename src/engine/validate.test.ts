import { describe, expect, it } from 'vitest';
import type { Appointment } from './types';
import { findConflicts } from './validate';

const appt = (slot: number, buyerId: string, supplierId: string): Appointment => ({
  slot,
  buyerId,
  supplierId,
  buyerRank: null,
  supplierRank: null,
  source: 'manual',
  pinned: false,
});

describe('findConflicts', () => {
  it('returns nothing for a clean schedule', () => {
    expect(findConflicts([appt(1, 'b1', 's1'), appt(1, 'b2', 's2'), appt(2, 'b1', 's2')])).toEqual([]);
  });

  it('reports a buyer in two places in one slot', () => {
    expect(findConflicts([appt(1, 'b1', 's1'), appt(1, 'b1', 's2')])).toEqual([
      { kind: 'buyer_double_booked', slot: 1, buyerId: 'b1', supplierIds: ['s1', 's2'] },
    ]);
  });

  it('reports a supplier with two buyers in one slot', () => {
    expect(findConflicts([appt(3, 'b1', 's1'), appt(3, 'b2', 's1')])).toEqual([
      { kind: 'supplier_double_booked', slot: 3, supplierId: 's1', buyerIds: ['b1', 'b2'] },
    ]);
  });

  it('reports the same pair meeting twice', () => {
    expect(findConflicts([appt(4, 'b1', 's1'), appt(2, 'b1', 's1')])).toEqual([
      { kind: 'duplicate_pair', buyerId: 'b1', supplierId: 's1', slots: [2, 4] },
    ]);
  });
});
