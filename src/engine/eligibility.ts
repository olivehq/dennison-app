import type { RankingIndex } from './rankings';
import type { Buyer, EventSettings, Supplier } from './types';

export type EligibilityContext = {
  index: RankingIndex;
  settings: Pick<EventSettings, 'biztechOptInRule'>;
};

/**
 * Scope 2.2 step 1. A pair is eligible unless the buyer rejected the
 * supplier (N/A), the buyer is opted out of biztech and the supplier is a
 * business (D1), or either person has withdrawn. The "pair already exists"
 * check lives in the schedule state, not here.
 */
export function isEligible(buyer: Buyer, supplier: Supplier, ctx: EligibilityContext): boolean {
  if (buyer.withdrawn || supplier.withdrawn) return false;
  if (ctx.index.isRejected(buyer.id, supplier.id)) return false;
  if (
    supplier.type === 'business' &&
    ctx.settings.biztechOptInRule === 'from_biztech_file' &&
    !buyer.biztechOptIn
  ) {
    return false;
  }
  return true;
}
