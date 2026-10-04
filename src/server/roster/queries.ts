import { and, count, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import {
  accessTokens,
  appointments,
  matchRuns,
  participants,
  suppliers,
  type Participant,
  type Supplier,
} from "@/db/schema";
import { compareNames } from "@/lib/names";
import { displayNameFor } from "./display-name";

export { displayNameFor, fullNameFor } from "./display-name";

export type RosterStatusInfo = {
  /** Appointments in the active match run. 0 when there is no active run. */
  appointmentCount: number;
  /** An unrevoked access token exists, so a schedule link is out or ready to send. */
  hasPendingToken: boolean;
};

export type ParticipantRow = Participant & RosterStatusInfo & { displayLabel: string };
export type SupplierRow = Supplier & RosterStatusInfo;

export type ListOptions = { includeWithdrawn?: boolean };

async function appointmentCounts(
  db: Db,
  eventId: string,
  column: typeof appointments.buyerId | typeof appointments.supplierId,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: column, total: count() })
    .from(appointments)
    .innerJoin(matchRuns, eq(appointments.runId, matchRuns.id))
    .where(and(eq(appointments.eventId, eventId), eq(matchRuns.isActive, true)))
    .groupBy(column);
  return new Map(rows.map((row) => [row.id, row.total]));
}

async function entitiesWithTokens(
  db: Db,
  eventId: string,
  contactTypes: ("buyer" | "supplier_admin" | "supplier_attendee")[],
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ entityId: accessTokens.entityId })
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.eventId, eventId),
        inArray(accessTokens.contactType, contactTypes),
        isNull(accessTokens.revokedAt),
      ),
    );
  return new Set(rows.map((row) => row.entityId));
}

function statusFilter(column: typeof participants.status | typeof suppliers.status, options: ListOptions): SQL | undefined {
  return options.includeWithdrawn ? undefined : eq(column, "active");
}

export async function listParticipants(
  eventId: string,
  options: ListOptions = {},
  db: Db = getDb(),
): Promise<ParticipantRow[]> {
  const [rows, counts, tokens] = await Promise.all([
    db
      .select()
      .from(participants)
      .where(and(eq(participants.eventId, eventId), statusFilter(participants.status, options)))
      .orderBy(participants.email),
    appointmentCounts(db, eventId, appointments.buyerId),
    entitiesWithTokens(db, eventId, ["buyer"]),
  ]);
  return rows
    .sort((a, b) => compareNames(a.lastName, b.lastName) || compareNames(a.firstName, b.firstName))
    .map((row) => ({
      ...row,
      displayLabel: displayNameFor(row),
      appointmentCount: counts.get(row.id) ?? 0,
      hasPendingToken: tokens.has(row.id),
    }));
}

export async function listSuppliers(
  eventId: string,
  options: ListOptions = {},
  db: Db = getDb(),
): Promise<SupplierRow[]> {
  const [rows, counts, tokens] = await Promise.all([
    db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.eventId, eventId), statusFilter(suppliers.status, options)))
      .orderBy(suppliers.id),
    appointmentCounts(db, eventId, appointments.supplierId),
    entitiesWithTokens(db, eventId, ["supplier_admin", "supplier_attendee"]),
  ]);
  return rows
    .sort((a, b) => compareNames(a.name, b.name))
    .map((row) => ({
      ...row,
      appointmentCount: counts.get(row.id) ?? 0,
      hasPendingToken: tokens.has(row.id),
    }));
}

export async function getParticipant(id: string, db: Db = getDb()): Promise<ParticipantRow | null> {
  const [row] = await db.select().from(participants).where(eq(participants.id, id)).limit(1);
  if (!row) return null;
  const [counts, tokens] = await Promise.all([
    appointmentCounts(db, row.eventId, appointments.buyerId),
    entitiesWithTokens(db, row.eventId, ["buyer"]),
  ]);
  return {
    ...row,
    displayLabel: displayNameFor(row),
    appointmentCount: counts.get(row.id) ?? 0,
    hasPendingToken: tokens.has(row.id),
  };
}

export async function getSupplier(id: string, db: Db = getDb()): Promise<SupplierRow | null> {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!row) return null;
  const [counts, tokens] = await Promise.all([
    appointmentCounts(db, row.eventId, appointments.supplierId),
    entitiesWithTokens(db, row.eventId, ["supplier_admin", "supplier_attendee"]),
  ]);
  return {
    ...row,
    appointmentCount: counts.get(row.id) ?? 0,
    hasPendingToken: tokens.has(row.id),
  };
}
