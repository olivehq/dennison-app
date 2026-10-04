/**
 * Test-only generators. Not part of the engine's public surface.
 * Everything is driven by a seeded mulberry32 so tests are repeatable.
 */
import type { Buyer, MatchInput, Ranking, Supplier, EventSettings } from '../types';

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

export const defaultSettings: EventSettings = {
  slotCount: 9,
  supplierTarget: 9,
  buyerMin: 7,
  buyerMax: 9,
  buyerIdeal: 8,
  mutualTopN: 10,
  hotelRankCutoff: 27,
  biztechOptInRule: 'from_biztech_file',
};

export type SyntheticOptions = {
  seed: number;
  buyers: number;
  business: number;
  hotels: number;
  /** Share of buyers opted out of biztech. */
  optOutShare?: number;
  /** Hotels each buyer rejects with N/A. */
  rejectionsPerBuyer?: number;
  /** Max suppliers a buyer ranks (eShow caps at 40 choices). */
  buyerChoiceCap?: number;
  /** Noise added to the latent fit. 0 = perfectly correlated preferences. */
  noise?: number;
  /** Share of buyers each supplier leaves blank. */
  supplierBlankShare?: number;
  settings?: Partial<EventSettings>;
};

/**
 * Preferences come from a latent 2-D "fit" space plus noise, so rankings are
 * correlated the way real ones are (a hotel that suits a buyer tends to want
 * that buyer too) without everyone chasing the same few names.
 */
export function syntheticEvent(opts: SyntheticOptions): MatchInput {
  const rand = mulberry32(opts.seed);
  const settings = { ...defaultSettings, ...opts.settings };
  const optOutShare = opts.optOutShare ?? 0.2;
  const rejections = opts.rejectionsPerBuyer ?? 2;
  const choiceCap = opts.buyerChoiceCap ?? 40;
  const blankShare = opts.supplierBlankShare ?? 0.15;
  const noise = opts.noise ?? 2.5;

  const buyers: Buyer[] = Array.from({ length: opts.buyers }, (_, i) => ({
    id: `b${pad(i)}`,
    biztechOptIn: rand() >= optOutShare,
  }));
  const suppliers: Supplier[] = [
    ...Array.from({ length: opts.business }, (_, i) => ({ id: `biz${pad(i)}`, type: 'business' as const })),
    ...Array.from({ length: opts.hotels }, (_, i) => ({ id: `hot${pad(i)}`, type: 'hotel' as const })),
  ];

  const point = () => [rand(), rand()] as const;
  const buyerPos = new Map(buyers.map((b) => [b.id, point()]));
  const supplierPos = new Map(suppliers.map((s) => [s.id, point()]));
  const fit = (b: string, s: string) => {
    const [bx, by] = buyerPos.get(b)!;
    const [sx, sy] = supplierPos.get(s)!;
    return Math.hypot(bx - sx, by - sy) + (rand() - 0.5) * noise;
  };

  const rankings: Ranking[] = [];
  for (const b of buyers) {
    const business = suppliers.filter((s) => s.type === 'business');
    const hotels = suppliers.filter((s) => s.type === 'hotel');
    // Business file: opted-in buyers rank every business supplier.
    if (b.biztechOptIn) {
      sortByFit(business, (s) => fit(b.id, s.id)).forEach((s, i) =>
        rankings.push(buyerRow(b.id, s.id, i + 1)),
      );
    }
    // Hotel file: ranked list up to the cap, then a few N/A rejections.
    const ordered = sortByFit(hotels, (s) => fit(b.id, s.id));
    const ranked = ordered.slice(0, Math.min(choiceCap, ordered.length - rejections));
    ranked.forEach((s, i) => rankings.push(buyerRow(b.id, s.id, i + 1)));
    for (const s of ordered.slice(ordered.length - rejections)) {
      rankings.push({ ...buyerRow(b.id, s.id, null), isRejection: true });
    }
  }
  for (const s of suppliers) {
    const ordered = sortByFit(buyers, (b) => fit(b.id, s.id));
    const keep = Math.round(ordered.length * (1 - blankShare));
    ordered.slice(0, keep).forEach((b, i) =>
      rankings.push({
        rankerType: 'supplier',
        rankerId: s.id,
        targetType: 'buyer',
        targetId: b.id,
        rank: i + 1,
        isRejection: false,
      }),
    );
  }

  return { settings, buyers, suppliers, rankings, pinned: [] };
}

function buyerRow(buyerId: string, supplierId: string, rank: number | null): Ranking {
  return {
    rankerType: 'buyer',
    rankerId: buyerId,
    targetType: 'supplier',
    targetId: supplierId,
    rank,
    isRejection: false,
  };
}

function sortByFit<T>(items: T[], score: (item: T) => number): T[] {
  return items
    .map((item) => ({ item, score: score(item) }))
    .sort((a, b) => a.score - b.score)
    .map((x) => x.item);
}

function pad(i: number): string {
  return String(i).padStart(3, '0');
}

/** Fisher-Yates with the given PRNG. Returns a new array. */
export function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
