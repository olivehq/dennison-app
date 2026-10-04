/**
 * Rankings for the demo event. The 2025 results only carry the ranks of the
 * 504 matched pairs, but swap candidates and re-runs need every pair ranked.
 * Matched pairs keep their real ranks; every other pair gets one of the
 * ranker's unused numbers, shuffled by a seeded PRNG so the demo is the same
 * every time.
 */

export const DEMO_RANK_SEED = 20251114;

/** mulberry32: a small, fast, seedable PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * One ranker's list over `targets`. `fixed` holds the real ranks: a number
 * is kept, null means the ranker left that pair blank and it stays unranked.
 * Everyone else gets the unused numbers from 1 to max(targets, highest real
 * rank), in shuffled order. No number repeats.
 */
export function fillRankList(
  targets: string[],
  fixed: ReadonlyMap<string, number | null>,
  random: () => number,
): Map<string, number | null> {
  const used = new Set<number>();
  for (const [target, rank] of fixed) {
    if (rank === null) continue;
    if (used.has(rank)) throw new Error(`Rank ${rank} is used twice (again for ${target}).`);
    used.add(rank);
  }
  const highest = Math.max(targets.length, ...used);
  const free = shuffle(
    Array.from({ length: highest }, (_, i) => i + 1).filter((n) => !used.has(n)),
    random,
  );
  const result = new Map<string, number | null>();
  let next = 0;
  for (const target of targets) {
    if (fixed.has(target)) {
      result.set(target, fixed.get(target) ?? null);
      continue;
    }
    result.set(target, free[next++]);
  }
  return result;
}

export type DemoRanking = {
  rankerType: "buyer" | "supplier";
  ranker: string;
  targetType: "buyer" | "supplier";
  target: string;
  rank: number;
};

type RankInput = {
  buyers: string[];
  suppliers: { name: string; type: "business" | "hotel" }[];
  appointments: { buyer: string; supplier: string; buyerRank: number | null; supplierRank: number | null }[];
};

/**
 * Buyers rank business and hotel suppliers as two separate lists (the 2025
 * files and the 2026 biztech and hotel files both work that way), so a buyer
 * holds a 1 in each. Suppliers rank every buyer in one list. Blank pairs
 * produce no row.
 */
export function buildDemoRankings(input: RankInput, seed: number = DEMO_RANK_SEED): DemoRanking[] {
  const random = mulberry32(seed);
  const buyerFixed = new Map<string, Map<string, number | null>>();
  const supplierFixed = new Map<string, Map<string, number | null>>();
  for (const a of input.appointments) {
    if (!buyerFixed.has(a.buyer)) buyerFixed.set(a.buyer, new Map());
    if (!supplierFixed.has(a.supplier)) supplierFixed.set(a.supplier, new Map());
    buyerFixed.get(a.buyer)!.set(a.supplier, a.buyerRank);
    supplierFixed.get(a.supplier)!.set(a.buyer, a.supplierRank);
  }

  const rows: DemoRanking[] = [];
  const groups = (["business", "hotel"] as const).map((type) =>
    input.suppliers.filter((s) => s.type === type).map((s) => s.name),
  );
  for (const buyer of input.buyers) {
    const fixed = buyerFixed.get(buyer) ?? new Map<string, number | null>();
    for (const group of groups) {
      const inGroup = new Map([...fixed].filter(([supplier]) => group.includes(supplier)));
      for (const [supplier, rank] of fillRankList(group, inGroup, random)) {
        if (rank !== null) rows.push({ rankerType: "buyer", ranker: buyer, targetType: "supplier", target: supplier, rank });
      }
    }
  }
  for (const { name: supplier } of input.suppliers) {
    const fixed = supplierFixed.get(supplier) ?? new Map<string, number | null>();
    for (const [buyer, rank] of fillRankList(input.buyers, fixed, random)) {
      if (rank !== null) rows.push({ rankerType: "supplier", ranker: supplier, targetType: "buyer", target: buyer, rank });
    }
  }
  return rows;
}
