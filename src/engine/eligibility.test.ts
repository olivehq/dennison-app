import { describe, expect, it } from 'vitest';
import { isEligible, type EligibilityContext } from './eligibility';
import { buildRankingIndex } from './rankings';
import type { Buyer, Supplier } from './types';

const buyer: Buyer = { id: 'b1', biztechOptIn: true };
const optedOut: Buyer = { id: 'b2', biztechOptIn: false };
const business: Supplier = { id: 'biz', type: 'business' };
const hotel: Supplier = { id: 'hot', type: 'hotel' };

const ctx = (rule: EligibilityContext['settings']['biztechOptInRule'] = 'from_biztech_file'): EligibilityContext => ({
  index: buildRankingIndex([
    { rankerType: 'buyer', rankerId: 'b1', targetType: 'supplier', targetId: 'hot', rank: null, isRejection: true },
  ]),
  settings: { biztechOptInRule: rule },
});

describe('isEligible', () => {
  it('rejects a pair the buyer marked N/A', () => {
    expect(isEligible(buyer, hotel, ctx())).toBe(false);
    expect(isEligible(buyer, business, ctx())).toBe(true);
  });

  it('keeps opted-out buyers away from business suppliers under from_biztech_file (D1)', () => {
    expect(isEligible(optedOut, business, ctx())).toBe(false);
    expect(isEligible(optedOut, hotel, ctx())).toBe(true);
  });

  it('ignores the opt-in flag under all_opted_in', () => {
    expect(isEligible(optedOut, business, ctx('all_opted_in'))).toBe(true);
  });

  it('excludes withdrawn people on either side', () => {
    expect(isEligible({ ...buyer, withdrawn: true }, business, ctx())).toBe(false);
    expect(isEligible(buyer, { ...business, withdrawn: true }, ctx())).toBe(false);
  });
});
