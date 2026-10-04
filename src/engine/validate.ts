import type { Appointment, Conflict } from './types';

/**
 * Finds hard-constraint violations in any schedule: a buyer or supplier in
 * two places in one slot, or the same pair meeting twice. The database has
 * unique indexes for the same rules; this gives the editor a readable list.
 */
export function findConflicts(appointments: Appointment[]): Conflict[] {
  const buyerSlots = groupBy(appointments, (a) => `${a.slot}\u0000${a.buyerId}`);
  const supplierSlots = groupBy(appointments, (a) => `${a.slot}\u0000${a.supplierId}`);
  const pairs = groupBy(appointments, (a) => `${a.buyerId}\u0000${a.supplierId}`);

  const conflicts: Conflict[] = [];
  for (const rows of buyerSlots.values()) {
    if (rows.length > 1) {
      conflicts.push({
        kind: 'buyer_double_booked',
        slot: rows[0].slot,
        buyerId: rows[0].buyerId,
        supplierIds: rows.map((r) => r.supplierId).sort(),
      });
    }
  }
  for (const rows of supplierSlots.values()) {
    if (rows.length > 1) {
      conflicts.push({
        kind: 'supplier_double_booked',
        slot: rows[0].slot,
        supplierId: rows[0].supplierId,
        buyerIds: rows.map((r) => r.buyerId).sort(),
      });
    }
  }
  for (const rows of pairs.values()) {
    if (rows.length > 1) {
      conflicts.push({
        kind: 'duplicate_pair',
        buyerId: rows[0].buyerId,
        supplierId: rows[0].supplierId,
        slots: rows.map((r) => r.slot).sort((a, b) => a - b),
      });
    }
  }
  return conflicts;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
