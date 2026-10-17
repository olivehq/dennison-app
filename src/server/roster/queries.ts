import { and, count, eq, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import {
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

function statusFilter(column: typeof participants.status | typeof suppliers.status, options: ListOptions): SQL | undefined {
  return options.includeWithdrawn ? undefined : eq(column, "active");
}

export async function listParticipants(
  eventId: string,
  options: ListOptions = {},
  db: Db = getDb(),
): Promise<ParticipantRow[]> {
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(participants)
      .where(and(eq(participants.eventId, eventId), statusFilter(participants.status, options)))
      .orderBy(participants.email),
    appointmentCounts(db, eventId, appointments.buyerId),
  ]);
  return rows
    .sort((a, b) => compareNames(a.lastName, b.lastName) || compareNames(a.firstName, b.firstName))
    .map((row) => ({
      ...row,
      displayLabel: displayNameFor(row),
      appointmentCount: counts.get(row.id) ?? 0,
    }));
}

export async function listSuppliers(
  eventId: string,
  options: ListOptions = {},
  db: Db = getDb(),
): Promise<SupplierRow[]> {
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.eventId, eventId), statusFilter(suppliers.status, options)))
      .orderBy(suppliers.id),
    appointmentCounts(db, eventId, appointments.supplierId),
  ]);
  return rows
    .sort((a, b) => compareNames(a.name, b.name))
    .map((row) => ({
      ...row,
      appointmentCount: counts.get(row.id) ?? 0,
    }));
}

export async function getParticipant(id: string, db: Db = getDb()): Promise<ParticipantRow | null> {
  const [row] = await db.select().from(participants).where(eq(participants.id, id)).limit(1);
  if (!row) return null;
  const counts = await appointmentCounts(db, row.eventId, appointments.buyerId);
  return {
    ...row,
    displayLabel: displayNameFor(row),
    appointmentCount: counts.get(row.id) ?? 0,
  };
}

export async function getSupplier(id: string, db: Db = getDb()): Promise<SupplierRow | null> {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!row) return null;
  const counts = await appointmentCounts(db, row.eventId, appointments.supplierId);
  return {
    ...row,
    appointmentCount: counts.get(row.id) ?? 0,
  };
}
