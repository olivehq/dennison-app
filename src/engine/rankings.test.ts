import { describe, expect, it } from 'vitest';
import { buildRankingIndex } from './rankings';
import type { Ranking } from './types';

const row = (partial: Partial<Ranking>): Ranking => ({
  rankerType: 'buyer',
  rankerId: 'b1',
  targetType: 'supplier',
  targetId: 's1',
  rank: null,
  isRejection: false,
  ...partial,
});

describe('buildRankingIndex', () => {
  it('looks up buyer and supplier ranks by direction', () => {
    const index = buildRankingIndex([
      row({ rank: 3 }),
      row({ rankerType: 'supplier', rankerId: 's1', targetType: 'buyer', targetId: 'b1', rank: 7 }),
    ]);
    expect(index.buyerRank('b1', 's1')).toBe(3);
    expect(index.supplierRank('s1', 'b1')).toBe(7);
    expect(index.buyerRank('b1', 's2')).toBeNull();
    expect(index.supplierRank('s2', 'b1')).toBeNull();
  });

  it('treats a blank as unranked and N/A as rejected', () => {
    const index = buildRankingIndex([row({ rank: null }), row({ targetId: 's2', isRejection: true })]);
    expect(index.buyerRank('b1', 's1')).toBeNull();
    expect(index.isRejected('b1', 's1')).toBe(false);
    expect(index.isRejected('b1', 's2')).toBe(true);
  });

  it('is mutual top-N only when both ranks are within N', () => {
    const index = buildRankingIndex([
      row({ rank: 10 }),
      row({ rankerType: 'supplier', rankerId: 's1', targetType: 'buyer', targetId: 'b1', rank: 11 }),
      row({ targetId: 's2', rank: 1 }),
      row({ rankerType: 'supplier', rankerId: 's2', targetType: 'buyer', targetId: 'b1', rank: 10 }),
    ]);
    expect(index.isMutualTopN('b1', 's1', 10)).toBe(false);
    expect(index.isMutualTopN('b1', 's2', 10)).toBe(true);
    expect(index.isMutualTopN('b1', 's3', 10)).toBe(false);
  });

  it('resolves duplicate rows to the best rank regardless of order', () => {
    const a = buildRankingIndex([row({ rank: 5 }), row({ rank: 2 }), row({ rank: null })]);
    const b = buildRankingIndex([row({ rank: null }), row({ rank: 2 }), row({ rank: 5 })]);
    expect(a.buyerRank('b1', 's1')).toBe(2);
    expect(b.buyerRank('b1', 's1')).toBe(2);
  });
});
