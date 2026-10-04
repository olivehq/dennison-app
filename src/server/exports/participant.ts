import { getDb, type Db } from "@/db/client";
import { getPersonSchedule, type PersonSchedule } from "@/server/schedule/views";
import { verifyToken } from "@/server/tokens/tokens";

/**
 * What `/s/[token]` renders: the contact's schedule with no rank data, or
 * null for any token that is unknown, revoked, expired, or belongs to someone
 * who has withdrawn. The page shows the same message for every null, so a
 * link reveals nothing about why it failed.
 */
export type ParticipantView = {
  contactType: "buyer" | "supplier_admin" | "supplier_attendee";
  schedule: PersonSchedule;
};

export async function loadParticipantView(token: string, db: Db = getDb()): Promise<ParticipantView | null> {
  const verified = await verifyToken(db, token);
  if (!verified) return null;
  const type = verified.contactType === "buyer" ? "buyer" : "supplier";
  const schedule = await getPersonSchedule(verified.eventId, { type, id: verified.entityId, forParticipant: true }, db);
  if (!schedule || schedule.person.withdrawn) return null;
  return { contactType: verified.contactType, schedule };
}
