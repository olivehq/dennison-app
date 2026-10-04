import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  participants,
  rankings,
  suppliers,
  type Event,
  type Participant,
  type Ranking as RankingRow,
  type Supplier,
} from "@/db/schema";
import type { Appointment, Buyer, MatchInput, Ranking, Supplier as EngineSupplier } from "@/engine";
import { buyerDisplayName, loadEvent } from "./common";

/** Everything about an event's people that the engine and the views need. */
export type Roster = {
  event: Event;
  participants: Participant[];
  suppliers: Supplier[];
  rankings: RankingRow[];
  /** Display name by id, buyers and suppliers together. */
  names: Map<string, string>;
};

export async function loadRoster(db: Db, eventId: string): Promise<Roster | null> {
  const event = await loadEvent(db, eventId);
  if (!event) return null;
  const [participantRows, supplierRows, rankingRows] = await Promise.all([
    db.select().from(participants).where(eq(participants.eventId, eventId)),
    db.select().from(suppliers).where(eq(suppliers.eventId, eventId)),
    db.select().from(rankings).where(eq(rankings.eventId, eventId)),
  ]);
  const names = new Map<string, string>();
  for (const p of participantRows) names.set(p.id, buyerDisplayName(p));
  for (const s of supplierRows) names.set(s.id, s.name);
  return { event, participants: participantRows, suppliers: supplierRows, rankings: rankingRows, names };
}

/** Engine buyers: every participant, withdrawn ones flagged so the engine skips them. */
export function toEngineBuyers(rows: Participant[]): Buyer[] {
  return rows.map((p) => ({
    id: p.id,
    biztechOptIn: p.biztechOptIn,
    withdrawn: p.status === "withdrawn",
  }));
}

export function toEngineSuppliers(rows: Supplier[]): EngineSupplier[] {
  return rows.map((s) => ({ id: s.id, type: s.type, withdrawn: s.status === "withdrawn" }));
}

export function toEngineRankings(rows: RankingRow[]): Ranking[] {
  return rows.map((r) => ({
    rankerType: r.rankerType,
    rankerId: r.rankerId,
    targetType: r.targetType,
    targetId: r.targetId,
    rank: r.rank,
    isRejection: r.isRejection,
  }));
}

/**
 * The engine contract (docs/ARCHITECTURE.md). Ids are database uuids. Only
 * active people are passed in; withdrawn people keep their rankings and past
 * appointments in the database but never reach the engine.
 */
export function buildMatchInput(roster: Roster, pinned: Appointment[]): MatchInput {
  return {
    settings: roster.event.settings,
    buyers: toEngineBuyers(roster.participants.filter((p) => p.status === "active")),
    suppliers: toEngineSuppliers(roster.suppliers.filter((s) => s.status === "active")),
    rankings: toEngineRankings(roster.rankings),
    pinned,
  };
}

export async function loadMatchInput(
  db: Db,
  eventId: string,
  options: { pinned: Appointment[] },
): Promise<MatchInput | null> {
  const roster = await loadRoster(db, eventId);
  if (!roster) return null;
  return buildMatchInput(roster, options.pinned);
}
