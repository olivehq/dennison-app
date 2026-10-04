/**
 * Engine contract. See docs/ARCHITECTURE.md "Engine contract" and
 * docs/PROJECT_SCOPE.md section 6 module 2.2.
 *
 * Ids are opaque strings. The engine never reads anything else about a
 * person, so the server can pass database ids straight through.
 */

export type ParticipantType = 'buyer' | 'supplier';
export type SupplierType = 'business' | 'hotel';

export type Buyer = {
  id: string;
  /** D1: opted-out buyers are never matched with business suppliers. */
  biztechOptIn: boolean;
  withdrawn?: boolean;
};

export type Supplier = {
  id: string;
  type: SupplierType;
  withdrawn?: boolean;
};

export type Ranking = {
  rankerType: ParticipantType;
  rankerId: string;
  targetType: ParticipantType;
  targetId: string;
  /** 1 is best. null means the ranker left the cell blank. */
  rank: number | null;
  /** Buyer N/A. An absolute rejection, never matched. */
  isRejection: boolean;
};

export type AppointmentSource = 'engine' | 'manual';

export type Appointment = {
  /** 1-based slot number. */
  slot: number;
  buyerId: string;
  supplierId: string;
  buyerRank: number | null;
  supplierRank: number | null;
  source: AppointmentSource;
  pinned: boolean;
};

export type BiztechOptInRule = 'from_biztech_file' | 'all_opted_in';

export type EventSettings = {
  slotCount: number;
  /** Hard: every supplier fills exactly this many slots when capacity allows. */
  supplierTarget: number;
  /** Soft range for buyers. */
  buyerMin: number;
  buyerMax: number;
  buyerIdeal: number;
  /** "Top 10" in the 2025 rules. */
  mutualTopN: number;
  /** Hotels skip buyer ranks above this in pass B. 27 in 2025. */
  hotelRankCutoff: number;
  biztechOptInRule: BiztechOptInRule;
};

export type MatchInput = {
  settings: EventSettings;
  buyers: Buyer[];
  suppliers: Supplier[];
  rankings: Ranking[];
  /** Kept exactly as placed. The engine fills only the remaining gaps. */
  pinned: Appointment[];
};

export type MatchResult = {
  appointments: Appointment[];
  stats: QualityStats;
  warnings: string[];
};

export type CountAndPct = {
  count: number;
  /** Percent of total appointments, 0 to 100, one decimal. */
  pct: number;
};

export type PersonCount = {
  id: string;
  count: number;
};

/**
 * Every number in sections A to G of the quality report
 * (2026_OUTPUT_GENERATION_PROMPT_TEMPLATE.txt section 3).
 * Percentages are of total appointments unless the name says otherwise.
 */
export type QualityStats = {
  // A. Overall
  totalAppointments: number;
  totalBuyers: number;
  totalSuppliers: number;
  /** Appointment count -> number of buyers with that count. Includes 0. */
  buyerDistribution: Record<number, number>;
  suppliersAtTarget: number;
  /** Percent of suppliers at exactly supplierTarget, 0 to 100. */
  supplierSuccessPct: number;
  buyersInRange: number;
  /** Percent of buyers with buyerMin to buyerMax appointments, 0 to 100. */
  buyersInRangePct: number;

  // B. Mutual top-N
  mutualTopN: CountAndPct;

  // C. One side top-N, not mutual
  oneSideTopN: CountAndPct & {
    /** Buyer ranked supplier in top N, supplier ranked buyer lower. */
    buyerOnly: number;
    /** Supplier ranked buyer in top N, buyer ranked supplier lower. */
    supplierOnly: number;
  };

  // D. Neither side top-N, both ranked
  neitherTopN: CountAndPct & {
    /** Both ranks in N+1 to 2N ("mutual ranks 11-20"). */
    bothWithin2N: number;
    /** Both ranks in 2N+1 to hotelRankCutoff ("mutual ranks 21-27"). */
    bothWithinCutoff: number;
    /** Both ranks above hotelRankCutoff ("mutual ranks >27"). */
    bothAboveCutoff: number;
    /** Any other combination ("mixed rankings"). */
    mixed: number;
  };

  // E. Blank rankings: one or both sides did not rank the other
  blankRankings: CountAndPct & {
    buyerBlank: number;
    supplierBlank: number;
  };
  withBuyerRank: CountAndPct;
  withSupplierRank: CountAndPct;

  // G. Key insights
  atLeastOneSideTopN: CountAndPct;

  // Lists for the report and the workspace
  buyersBelowMin: PersonCount[];
  buyersAboveMax: PersonCount[];
  suppliersOffTarget: PersonCount[];

  /** Thresholds the report labels are built from. */
  thresholds: {
    mutualTopN: number;
    hotelRankCutoff: number;
    supplierTarget: number;
    buyerMin: number;
    buyerMax: number;
  };
};

/** A hard-constraint violation found in a schedule. */
export type Conflict =
  | { kind: 'buyer_double_booked'; slot: number; buyerId: string; supplierIds: string[] }
  | { kind: 'supplier_double_booked'; slot: number; supplierId: string; buyerIds: string[] }
  | { kind: 'duplicate_pair'; buyerId: string; supplierId: string; slots: number[] };
