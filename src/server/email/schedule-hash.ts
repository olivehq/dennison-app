import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { emailMessages, type ContactType, type EmailMessageStatus } from "@/db/schema";
import { recipientKey } from "@/lib/schemas/email";
import { getPersonSchedule, getScheduleView, type PersonRef } from "@/server/schedule/views";
import { listContacts } from "@/server/tokens/tokens";

/**
 * "Changed since last email" (D13). Each sent message stores a hash of the
 * schedule it described; a person has changed when the hash of their current
 * schedule differs from the one on their most recent message that reached
 * them.
 */

/** Statuses that mean the message reached the person, so its hash is their baseline (D61). */
export const BASELINE_STATUSES: readonly EmailMessageStatus[] = ["sent", "delivered", "complained"];

type HashSlot = {
  slot: number;
  start: string;
  end: string;
  counterpartId: string | null;
  desk: number | null;
};

/** SHA-256 over every slot (number, times, counterpart, desk), OPEN slots included, in slot order. */
export function hashSlots(slots: HashSlot[]): string {
  const canonical = [...slots]
    .sort((a, b) => a.slot - b.slot)
    .map((s) => [s.slot, s.start, s.end, s.counterpartId, s.desk]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function personRef(contactType: ContactType, entityId: string): PersonRef {
  return { type: contactType === "buyer" ? "buyer" : "supplier", id: entityId };
}

function personKey(ref: PersonRef): string {
  return `${ref.type}:${ref.id}`;
}

/** The hash of one contact's current schedule, or null when the person does not exist. */
export async function scheduleHashFor(
  db: Db,
  eventId: string,
  contactType: ContactType,
  entityId: string,
): Promise<string | null> {
  const schedule = await getPersonSchedule(eventId, { ...personRef(contactType, entityId), forParticipant: true }, db);
  if (!schedule) return null;
  return hashSlots(
    schedule.slots.map((s) => ({
      slot: s.slot,
      start: s.start,
      end: s.end,
      counterpartId: s.appointment?.counterpartId ?? null,
      desk: s.appointment?.desk ?? null,
    })),
  );
}

/**
 * Current hashes for every buyer and supplier of the event, keyed by
 * "buyer:<id>" or "supplier:<id>". One read of the schedule instead of one per
 * person; the result matches `scheduleHashFor` (tested).
 */
export async function scheduleHashesForEvent(db: Db, eventId: string): Promise<Map<string, string>> {
  const view = await getScheduleView(eventId, db);
  const hashes = new Map<string, string>();
  if (!view) return hashes;
  const deskBySupplier = new Map(view.suppliers.map((s) => [s.id, s.desk]));
  const byBuyer = new Map<string, Map<number, { counterpartId: string; desk: number | null }>>();
  const bySupplier = new Map<string, Map<number, { counterpartId: string; desk: number | null }>>();
  for (const a of view.appointments) {
    const desk = deskBySupplier.get(a.supplierId) ?? null;
    if (!byBuyer.has(a.buyerId)) byBuyer.set(a.buyerId, new Map());
    byBuyer.get(a.buyerId)!.set(a.slot, { counterpartId: a.supplierId, desk });
    if (!bySupplier.has(a.supplierId)) bySupplier.set(a.supplierId, new Map());
    bySupplier.get(a.supplierId)!.set(a.slot, { counterpartId: a.buyerId, desk });
  }
  const hashFor = (booked: Map<number, { counterpartId: string; desk: number | null }> | undefined) =>
    hashSlots(
      view.slots.map((s) => {
        const a = booked?.get(s.slot);
        return { slot: s.slot, start: s.start, end: s.end, counterpartId: a?.counterpartId ?? null, desk: a?.desk ?? null };
      }),
    );
  for (const b of view.buyers) hashes.set(personKey({ type: "buyer", id: b.id }), hashFor(byBuyer.get(b.id)));
  for (const s of view.suppliers) hashes.set(personKey({ type: "supplier", id: s.id }), hashFor(bySupplier.get(s.id)));
  return hashes;
}

/** The hash for a contact out of `scheduleHashesForEvent`. */
export function hashForContact(hashes: Map<string, string>, contactType: ContactType, entityId: string): string | null {
  return hashes.get(personKey(personRef(contactType, entityId))) ?? null;
}

export type ScheduleChangeState = {
  /** Recipient keys with at least one message that reached them. */
  emailed: Set<string>;
  /** Emailed contacts, still active with an email address, whose schedule differs from their last email. */
  changed: Set<string>;
};

export async function scheduleChangeState(db: Db, eventId: string): Promise<ScheduleChangeState> {
  const baselines = await db
    .selectDistinctOn([emailMessages.contactType, emailMessages.entityId], {
      contactType: emailMessages.contactType,
      entityId: emailMessages.entityId,
      scheduleHash: emailMessages.scheduleHash,
    })
    .from(emailMessages)
    .where(and(eq(emailMessages.eventId, eventId), inArray(emailMessages.status, [...BASELINE_STATUSES])))
    .orderBy(emailMessages.contactType, emailMessages.entityId, desc(emailMessages.createdAt));
  const emailed = new Set(baselines.map((b) => recipientKey(b.contactType, b.entityId)));
  const changed = new Set<string>();
  if (baselines.length === 0) return { emailed, changed };

  const [hashes, contacts] = await Promise.all([scheduleHashesForEvent(db, eventId), listContacts(db, eventId)]);
  const reachable = new Set(contacts.map((c) => recipientKey(c.contactType, c.entityId)));
  for (const b of baselines) {
    const key = recipientKey(b.contactType, b.entityId);
    if (!reachable.has(key)) continue;
    const current = hashForContact(hashes, b.contactType, b.entityId);
    if (current !== null && current !== b.scheduleHash) changed.add(key);
  }
  return { emailed, changed };
}

/** Recipient keys ("buyer:<id>", "supplier_admin:<id>", ...) whose schedule changed since their last email (D13). */
export async function changedSinceLastSend(db: Db, eventId: string): Promise<Set<string>> {
  return (await scheduleChangeState(db, eventId)).changed;
}

export async function countChangedSinceLastSend(db: Db, eventId: string): Promise<number> {
  return (await changedSinceLastSend(db, eventId)).size;
}
