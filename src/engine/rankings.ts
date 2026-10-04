import type { Ranking } from './types';

/** Fast lookups over the flat rankings array. */
export type RankingIndex = {
  buyerRank: (buyerId: string, supplierId: string) => number | null;
  supplierRank: (supplierId: string, buyerId: string) => number | null;
  isRejected: (buyerId: string, supplierId: string) => boolean;
  isMutualTopN: (buyerId: string, supplierId: string, n: number) => boolean;
};

export function pairKey(buyerId: string, supplierId: string): string {
  return `${buyerId}\u0000${supplierId}`;
}

export function buildRankingIndex(rankings: Ranking[]): RankingIndex {
  const buyerRanks = new Map<string, number>();
  const supplierRanks = new Map<string, number>();
  const rejected = new Set<string>();

  for (const r of rankings) {
    if (r.rankerType === 'buyer' && r.targetType === 'supplier') {
      const key = pairKey(r.rankerId, r.targetId);
      if (r.isRejection) rejected.add(key);
      keepBest(buyerRanks, key, r.rank);
    } else if (r.rankerType === 'supplier' && r.targetType === 'buyer') {
      keepBest(supplierRanks, pairKey(r.targetId, r.rankerId), r.rank);
    }
  }

  const buyerRank = (b: string, s: string) => buyerRanks.get(pairKey(b, s)) ?? null;
  const supplierRank = (s: string, b: string) => supplierRanks.get(pairKey(b, s)) ?? null;

  return {
    buyerRank,
    supplierRank,
    isRejected: (b, s) => rejected.has(pairKey(b, s)),
    isMutualTopN: (b, s, n) => isTopN(buyerRank(b, s), n) && isTopN(supplierRank(s, b), n),
  };
}

/** Duplicate rows resolve to the best rank so the index is order-independent. */
function keepBest(map: Map<string, number>, key: string, rank: number | null) {
  if (rank === null) return;
  const current = map.get(key);
  if (current === undefined || rank < current) map.set(key, rank);
}

export function isTopN(rank: number | null, n: number): boolean {
  return rank !== null && rank <= n;
}
