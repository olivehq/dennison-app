import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { emailMessages, type ContactType, type EmailMessageStatus } from "@/db/schema";
import { recipientKey } from "@/lib/schemas/email";
import {
  loadActiveSchedule,
  participantSlots,
  type ParticipantSlot,
  type PersonRef,
} from "@/server/schedule/snapshot";
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

/** The hash of what the participant page shows (D141): the same slots, counterparts, and desks. */
function hashParticipantSlots(slots: ParticipantSlot[]): string {
  return hashSlots(
    slots.map((s) => ({
      slot: s.slot,
      start: s.start,
      end: s.end,
      counterpartId: s.appointment?.counterpartId ?? null,
      desk: s.appointment?.desk ?? null,
    })),
  );
}

function personRef(contactType: ContactType, entityId: string): PersonRef {
  return { type: contactType === "buyer" ? "buyer" : "supplier", id: entityId };
}

function personKey(ref: PersonRef): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * Current hashes for every buyer and supplier of the event, keyed by
 * "buyer:<id>" or "supplier:<id>". One read of the active schedule instead of
 * one per person.
 */
export async function scheduleHashesForEvent(db: Db, eventId: string): Promise<Map<string, string>> {
  const schedule = await loadActiveSchedule(db, eventId);
  const hashes = new Map<string, string>();
  if (!schedule) return hashes;
  for (const ref of [
    ...schedule.buyers.map((b): PersonRef => ({ type: "buyer", id: b.id })),
    ...schedule.suppliers.map((s): PersonRef => ({ type: "supplier", id: s.id })),
  ]) {
    hashes.set(personKey(ref), hashParticipantSlots(participantSlots(schedule, ref)));
  }
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
