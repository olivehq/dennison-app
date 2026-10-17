import { eq } from "drizzle-orm";
import { z } from "zod";
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
import { getEvent } from "@/server/events/queries";
import { displayNameFor } from "@/server/roster/display-name";

/** An event and its people, without rankings. What schedule reads need. */
export type People = {
  event: Event;
  participants: Participant[];
  suppliers: Supplier[];
  /** Display name by id, buyers and suppliers together. */
  names: Map<string, string>;
};

/** Everything about an event's people that the engine and edits need: people plus every ranking. */
export type Roster = People & { rankings: RankingRow[] };

const uuidSchema = z.uuid();

/** The event, its participants, and its suppliers, read together. Null when the event does not exist. */
export async function loadPeople(db: Db, eventId: string): Promise<People | null> {
  // The roster queries compare uuid columns, so a malformed id must stop here.
  if (!uuidSchema.safeParse(eventId).success) return null;
  const [event, participantRows, supplierRows] = await Promise.all([
    getEvent(eventId, db),
    db.select().from(participants).where(eq(participants.eventId, eventId)),
    db.select().from(suppliers).where(eq(suppliers.eventId, eventId)),
  ]);
  if (!event) return null;
  const names = new Map<string, string>();
  for (const p of participantRows) names.set(p.id, displayNameFor(p));
  for (const s of supplierRows) names.set(s.id, s.name);
  return { event, participants: participantRows, suppliers: supplierRows, names };
}

/** People plus every ranking of the event. Only the engine, edits, and run saves need the rankings. */
export async function loadRoster(db: Db, eventId: string): Promise<Roster | null> {
  if (!uuidSchema.safeParse(eventId).success) return null;
  const [people, rankingRows] = await Promise.all([
    loadPeople(db, eventId),
    db.select().from(rankings).where(eq(rankings.eventId, eventId)),
  ]);
  if (!people) return null;
  return { ...people, rankings: rankingRows };
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
