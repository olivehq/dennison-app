import { isEligible, type EligibilityContext } from './eligibility';
import { buildRankingIndex, pairKey, type RankingIndex } from './rankings';
import { compareIds, computeStats } from './stats';
import type {
  Appointment,
  Buyer,
  EventSettings,
  MatchInput,
  MatchResult,
  Supplier,
  SupplierType,
} from './types';
import { findConflicts } from './validate';

/**
 * Mutable schedule state while matching. Slot sets and counts are the
 * authority; `appointments` is the row list that becomes the output.
 */
type State = {
  settings: EventSettings;
  buyers: Buyer[];
  suppliers: Supplier[];
  buyerById: Map<string, Buyer>;
  supplierById: Map<string, Supplier>;
  index: RankingIndex;
  ctx: EligibilityContext;
  buyerSlots: Map<string, Set<number>>;
  supplierSlots: Map<string, Set<number>>;
  pairs: Set<string>;
  buyerCount: Map<string, number>;
  supplierCount: Map<string, number>;
  /** Active buyers still free in each slot, indexed by slot number. */
  freeBuyersInSlot: number[];
  appointments: Appointment[];
  warnings: string[];
};

/**
 * The 2025 rules as written in docs/PROJECT_SCOPE.md 6/2.2. Deterministic:
 * every tie is broken by id string order, and no randomness or clock is used.
 */
export function runMatching(input: MatchInput): MatchResult {
  const state = createState(input);
  placePinned(state, input.pinned);

  // Scope 2.2 step 2: business suppliers first, hotels second.
  runPhase(state, 'business');
  runPhase(state, 'hotel');
  repair(state);

  const appointments = sortAppointments(state.appointments);
  addCountWarnings(state);
  return {
    appointments,
    stats: computeStats(appointments, input),
    warnings: state.warnings,
  };
}

/**
 * Runs only the repair pass over an existing schedule. Rows are kept as given
 * (pinned ones are never moved). Lets the app offer "fix low buyers" on a
 * hand-edited schedule without re-running the matcher.
 */
export function repairSchedule(appointments: Appointment[], input: MatchInput): MatchResult {
  const state = createState(input);
  placePinned(state, appointments);
  repair(state);
  const sorted = sortAppointments(state.appointments);
  addCountWarnings(state);
  return { appointments: sorted, stats: computeStats(sorted, input), warnings: state.warnings };
}

function createState(input: MatchInput): State {
  const buyers = input.buyers.filter((b) => !b.withdrawn).sort((a, b) => compareIds(a.id, b.id));
  const suppliers = input.suppliers
    .filter((s) => !s.withdrawn)
    .sort((a, b) => compareIds(a.id, b.id));
  const index = buildRankingIndex(input.rankings);
  const slotCount = input.settings.slotCount;
  return {
    settings: input.settings,
    buyers,
    suppliers,
    buyerById: new Map(buyers.map((b) => [b.id, b])),
    supplierById: new Map(suppliers.map((s) => [s.id, s])),
    index,
    ctx: { index, settings: input.settings },
    buyerSlots: new Map(buyers.map((b) => [b.id, new Set<number>()])),
    supplierSlots: new Map(suppliers.map((s) => [s.id, new Set<number>()])),
    pairs: new Set(),
    buyerCount: new Map(buyers.map((b) => [b.id, 0])),
    supplierCount: new Map(suppliers.map((s) => [s.id, 0])),
    freeBuyersInSlot: Array.from({ length: slotCount + 1 }, () => buyers.length),
    appointments: [],
    warnings: [],
  };
}

/**
 * Pinned rows are placed first and never moved. Rows that name a withdrawn
 * or unknown person, pair people who are no longer eligible (an N/A or a
 * biztech opt-out after a re-import), or break a hard constraint against an
 * earlier pinned row, are dropped with a warning instead of corrupting the schedule.
 */
function placePinned(state: State, pinned: Appointment[]) {
  const sorted = sortAppointments(pinned);
  const kept: Appointment[] = [];
  for (const row of sorted) {
    const reason = pinnedProblem(state, row, kept);
    if (reason) {
      state.warnings.push(
        `Dropped pinned appointment slot ${row.slot} ${row.buyerId} x ${row.supplierId}: ${reason}`,
      );
      continue;
    }
    kept.push(row);
    book(state, row);
  }
}

function pinnedProblem(state: State, row: Appointment, kept: Appointment[]): string | null {
  if (!state.buyerById.has(row.buyerId)) return 'buyer is withdrawn or unknown';
  if (!state.supplierById.has(row.supplierId)) return 'supplier is withdrawn or unknown';
  if (row.slot < 1 || row.slot > state.settings.slotCount) return 'slot is out of range';
  const buyer = state.buyerById.get(row.buyerId)!;
  const supplier = state.supplierById.get(row.supplierId)!;
  if (!isEligible(buyer, supplier, state.ctx)) {
    return state.index.isRejected(buyer.id, supplier.id)
      ? `${buyer.id} marked ${supplier.id} as N/A`
      : `${buyer.id} is not opted in to business meetings`;
  }
  if (findConflicts([...kept, row]).length > 0) return 'conflicts with another pinned appointment';
  return null;
}

/** Scope 2.2 step 2: most constrained supplier first, ties by id. */
function runPhase(state: State, type: SupplierType) {
  const ordered = state.suppliers
    .filter((s) => s.type === type)
    .map((s) => ({ supplier: s, mutual: mutualCandidates(state, s).length }))
    .sort((a, b) => a.mutual - b.mutual || compareIds(a.supplier.id, b.supplier.id))
    .map((x) => x.supplier);
  for (const supplier of ordered) fillSupplier(state, supplier);
}

function fillSupplier(state: State, supplier: Supplier) {
  if (remaining(state, supplier) <= 0) return;
  passA(state, supplier);
  if (remaining(state, supplier) <= 0) return;
  passB(state, supplier);
  if (remaining(state, supplier) <= 0) return;
  passC(state, supplier);
}

function remaining(state: State, supplier: Supplier): number {
  return state.settings.supplierTarget - (state.supplierCount.get(supplier.id) ?? 0);
}

/** Buyers this supplier could still be matched with, in id order. */
function openCandidates(state: State, supplier: Supplier): Buyer[] {
  return state.buyers.filter(
    (b) =>
      !state.pairs.has(pairKey(b.id, supplier.id)) &&
      (state.buyerCount.get(b.id) ?? 0) < state.settings.buyerMax &&
      isEligible(b, supplier, state.ctx),
  );
}

function mutualCandidates(state: State, supplier: Supplier): Buyer[] {
  const n = state.settings.mutualTopN;
  return openCandidates(state, supplier).filter((b) =>
    state.index.isMutualTopN(b.id, supplier.id, n),
  );
}

/** Pass A: mutual top-N, best combined rank first. */
function passA(state: State, supplier: Supplier) {
  const preferLow = belowIdealFirst(state);
  const ranked = mutualCandidates(state, supplier)
    .map((b) => scored(state, b, supplier))
    .sort(
      (a, b) =>
        preferLow(a, b) || a.combined - b.combined || a.buyerRank - b.buyerRank || compareIds(a.id, b.id),
    );
  for (const c of ranked) {
    if (remaining(state, supplier) <= 0) return;
    tryPlace(state, c.buyer, supplier);
  }
}

/**
 * Pass B: alternate between the best unused candidate by buyer rank and the
 * best by supplier rank. Hotels skip buyer ranks above hotelRankCutoff and
 * blank buyer ranks here (scope 2.2 step 3, "soft limit at ranking 27").
 */
function passB(state: State, supplier: Supplier) {
  const candidates = openCandidates(state, supplier)
    .map((b) => scored(state, b, supplier))
    .filter((c) => supplier.type !== 'hotel' || c.buyerRank <= state.settings.hotelRankCutoff);

  const preferLow = belowIdealFirst(state);
  const byBuyer = candidates
    .filter((c) => c.buyerRank !== UNRANKED)
    .sort(
      (a, b) =>
        preferLow(a, b) || a.buyerRank - b.buyerRank || a.supplierRank - b.supplierRank || compareIds(a.id, b.id),
    );
  const bySupplier = candidates
    .filter((c) => c.supplierRank !== UNRANKED)
    .sort(
      (a, b) =>
        preferLow(a, b) || a.supplierRank - b.supplierRank || a.buyerRank - b.buyerRank || compareIds(a.id, b.id),
    );

  const tried = new Set<string>();
  const lists = [byBuyer, bySupplier];
  const cursors = [0, 0];
  let side = 0;
  while (remaining(state, supplier) > 0) {
    const next = nextUntried(lists[side], cursors, side, tried);
    if (!next) {
      side = 1 - side;
      if (!nextUntried(lists[side], cursors, side, tried)) return;
      continue;
    }
    tried.add(next.id);
    tryPlace(state, next.buyer, supplier);
    side = 1 - side;
  }
}

function nextUntried(list: Scored[], cursors: number[], side: number, tried: Set<string>): Scored | null {
  while (cursors[side] < list.length) {
    const c = list[cursors[side]];
    if (!tried.has(c.id)) return c;
    cursors[side]++;
  }
  return null;
}

/** Pass C: any eligible buyer, lowest count first, blanks and far ranks included. */
function passC(state: State, supplier: Supplier) {
  const ranked = openCandidates(state, supplier)
    .map((b) => scored(state, b, supplier))
    .sort(
      (a, b) =>
        a.count - b.count || a.buyerRank - b.buyerRank || a.supplierRank - b.supplierRank || compareIds(a.id, b.id),
    );
  for (const c of ranked) {
    if (remaining(state, supplier) <= 0) return;
    tryPlace(state, c.buyer, supplier);
  }
}

/** Sentinel so blank ranks sort after every real rank. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

type Scored = {
  id: string;
  buyer: Buyer;
  buyerRank: number;
  supplierRank: number;
  combined: number;
  count: number;
};

function scored(state: State, buyer: Buyer, supplier: Supplier): Scored {
  const buyerRank = state.index.buyerRank(buyer.id, supplier.id) ?? UNRANKED;
  const supplierRank = state.index.supplierRank(supplier.id, buyer.id) ?? UNRANKED;
  return {
    id: buyer.id,
    buyer,
    buyerRank,
    supplierRank,
    combined: buyerRank + supplierRank,
    count: state.buyerCount.get(buyer.id) ?? 0,
  };
}

/**
 * Scope 2.2 step 3: prefer buyers below buyerIdeal. Buyers already at or
 * above the ideal sort after everyone else, then rank order applies.
 */
function belowIdealFirst(state: State) {
  const ideal = state.settings.buyerIdeal;
  return (a: Scored, b: Scored) => Number(a.count >= ideal) - Number(b.count >= ideal);
}

function tryPlace(state: State, buyer: Buyer, supplier: Supplier): boolean {
  if ((state.buyerCount.get(buyer.id) ?? 0) >= state.settings.buyerMax) return false;
  if (state.pairs.has(pairKey(buyer.id, supplier.id))) return false;
  const slot = pickSlot(state, buyer.id, supplier.id);
  if (slot === null) return false;
  book(state, {
    slot,
    buyerId: buyer.id,
    supplierId: supplier.id,
    buyerRank: state.index.buyerRank(buyer.id, supplier.id),
    supplierRank: state.index.supplierRank(supplier.id, buyer.id),
    source: 'engine',
    pinned: false,
  });
  return true;
}

/**
 * A slot free for both. Among those, the slot with the most buyers still
 * free, so later suppliers keep room. Ties go to the lowest slot number.
 */
function pickSlot(state: State, buyerId: string, supplierId: string): number | null {
  const taken = state.buyerSlots.get(buyerId)!;
  const supplierTaken = state.supplierSlots.get(supplierId)!;
  let best: number | null = null;
  let bestFree = -1;
  for (let slot = 1; slot <= state.settings.slotCount; slot++) {
    if (taken.has(slot) || supplierTaken.has(slot)) continue;
    const free = state.freeBuyersInSlot[slot];
    if (free > bestFree) {
      best = slot;
      bestFree = free;
    }
  }
  return best;
}

function book(state: State, row: Appointment) {
  state.appointments.push(row);
  state.buyerSlots.get(row.buyerId)!.add(row.slot);
  state.supplierSlots.get(row.supplierId)!.add(row.slot);
  state.pairs.add(pairKey(row.buyerId, row.supplierId));
  state.buyerCount.set(row.buyerId, (state.buyerCount.get(row.buyerId) ?? 0) + 1);
  state.supplierCount.set(row.supplierId, (state.supplierCount.get(row.supplierId) ?? 0) + 1);
  state.freeBuyersInSlot[row.slot]--;
}

function unbook(state: State, row: Appointment) {
  const i = state.appointments.indexOf(row);
  if (i >= 0) state.appointments.splice(i, 1);
  state.buyerSlots.get(row.buyerId)!.delete(row.slot);
  state.supplierSlots.get(row.supplierId)!.delete(row.slot);
  state.pairs.delete(pairKey(row.buyerId, row.supplierId));
  state.buyerCount.set(row.buyerId, (state.buyerCount.get(row.buyerId) ?? 0) - 1);
  state.supplierCount.set(row.supplierId, (state.supplierCount.get(row.supplierId) ?? 0) - 1);
  state.freeBuyersInSlot[row.slot]++;
}

/**
 * Scope 2.2 step 4. For each buyer below buyerMin, take one appointment from
 * a buyer at buyerMax where the low buyer is eligible and free in that slot.
 * Donors keep at least buyerMin (buyerMax - 1 >= buyerMin is checked). Pinned
 * rows are never moved. Each move reduces the deficit, so this terminates;
 * the iteration cap is a second guard.
 */
function repair(state: State) {
  const { buyerMin, buyerMax } = state.settings;
  if (buyerMax - 1 < buyerMin) return;
  const maxMoves = state.buyers.length * state.settings.slotCount;
  for (let i = 0; i < maxMoves; i++) {
    const low = state.buyers
      .filter((b) => (state.buyerCount.get(b.id) ?? 0) < buyerMin)
      .sort(
        (a, b) =>
          (state.buyerCount.get(a.id) ?? 0) - (state.buyerCount.get(b.id) ?? 0) || compareIds(a.id, b.id),
      );
    if (low.length === 0) return;
    let moved = false;
    for (const buyer of low) {
      const donor = findDonor(state, buyer);
      if (!donor) continue;
      unbook(state, donor);
      const supplier = state.supplierById.get(donor.supplierId)!;
      book(state, {
        slot: donor.slot,
        buyerId: buyer.id,
        supplierId: supplier.id,
        buyerRank: state.index.buyerRank(buyer.id, supplier.id),
        supplierRank: state.index.supplierRank(supplier.id, buyer.id),
        source: 'engine',
        pinned: false,
      });
      moved = true;
      break;
    }
    if (!moved) return;
  }
}

/** The movable appointment whose current buyer loses the least, ties by ids. */
function findDonor(state: State, low: Buyer): Appointment | null {
  const { buyerMax } = state.settings;
  const lowSlots = state.buyerSlots.get(low.id)!;
  let best: Appointment | null = null;
  let bestLoss = -1;
  for (const row of state.appointments) {
    if (row.pinned) continue;
    if ((state.buyerCount.get(row.buyerId) ?? 0) !== buyerMax) continue;
    if (lowSlots.has(row.slot)) continue;
    if (state.pairs.has(pairKey(low.id, row.supplierId))) continue;
    const supplier = state.supplierById.get(row.supplierId)!;
    if (!isEligible(low, supplier, state.ctx)) continue;
    // Higher combined rank means the donor valued this meeting less.
    const loss =
      (state.index.buyerRank(row.buyerId, row.supplierId) ?? UNRANKED) +
      (state.index.supplierRank(row.supplierId, row.buyerId) ?? UNRANKED);
    if (loss > bestLoss || (loss === bestLoss && best && compareRows(row, best) < 0)) {
      best = row;
      bestLoss = loss;
    }
  }
  return best;
}

function addCountWarnings(state: State) {
  const { supplierTarget, buyerMin, buyerMax } = state.settings;
  for (const s of state.suppliers) {
    const count = state.supplierCount.get(s.id) ?? 0;
    if (count !== supplierTarget) {
      state.warnings.push(`Supplier ${s.id} filled only ${count} of ${supplierTarget}`);
    }
  }
  for (const b of state.buyers) {
    const count = state.buyerCount.get(b.id) ?? 0;
    if (count < buyerMin) state.warnings.push(`Buyer ${b.id} has ${count} appointments (min ${buyerMin})`);
    if (count > buyerMax) state.warnings.push(`Buyer ${b.id} has ${count} appointments (max ${buyerMax})`);
  }
}

function compareRows(a: Appointment, b: Appointment): number {
  return a.slot - b.slot || compareIds(a.supplierId, b.supplierId) || compareIds(a.buyerId, b.buyerId);
}

export function sortAppointments(rows: Appointment[]): Appointment[] {
  return [...rows].sort(compareRows);
}
