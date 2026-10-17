import { getDb, type Db } from "@/db/client";
import { loadPersonSchedule, type PersonSchedule } from "@/server/schedule/snapshot";
import { verifyToken, type VerifyTokenOptions } from "@/server/tokens/tokens";

/**
 * What `/s/[token]` renders: the contact's schedule with no rank data, or
 * null for any token that is unknown, revoked, expired, or belongs to someone
 * who has withdrawn. The page shows the same message for every null, so a
 * link reveals nothing about why it failed. Three queries: the token, then
 * the person with their event and their meetings together.
 */
export type ParticipantView = {
  contactType: "buyer" | "supplier_admin" | "supplier_attendee";
  schedule: PersonSchedule;
};

export async function loadParticipantView(
  token: string,
  db: Db = getDb(),
  options: VerifyTokenOptions = {},
): Promise<ParticipantView | null> {
  const verified = await verifyToken(db, token, options);
  if (!verified) return null;
  const type = verified.contactType === "buyer" ? "buyer" : "supplier";
  const schedule = await loadPersonSchedule(db, verified.eventId, { type, id: verified.entityId });
  if (!schedule || schedule.person.withdrawn) return null;
  return { contactType: verified.contactType, schedule };
}
