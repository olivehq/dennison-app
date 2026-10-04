import { TZDate } from "@date-fns/tz";
import { addDays, endOfDay } from "date-fns";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  accessTokens,
  participants,
  suppliers,
  type AccessToken,
  type ContactType,
} from "@/db/schema";
import { env } from "@/lib/env";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { generateToken, hashToken } from "@/lib/tokens";
import { buyerDisplayName, loadEvent } from "@/server/matching/common";

/**
 * Participant access links (D14, scope 2.6). One token per contact: every
 * active buyer, and each active supplier's admin and attendee contact. The
 * plain token exists only in the return value of the function that issued it.
 */

export const TOKEN_TTL_DAYS = 60;

export type ContactRef = {
  contactType: ContactType;
  /** participants.id for buyers, suppliers.id for both supplier contacts. */
  entityId: string;
  name: string;
  email: string;
};

export type IssuedToken = ContactRef & {
  tokenId: string;
  token: string;
  expiresAt: Date;
};

export type VerifiedToken = {
  tokenId: string;
  eventId: string;
  contactType: ContactType;
  entityId: string;
};

export function linkFor(token: string): string {
  return `${env.APP_URL}/s/${token}`;
}

/** End of the day 60 days after the event, in the event's timezone (D14, D16). */
export function tokenExpiry(eventDate: string, timezone: string, ttlDays = TOKEN_TTL_DAYS): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDate);
  if (!match) throw new RangeError(`Expected an ISO date (YYYY-MM-DD), got "${eventDate}"`);
  const [, year, month, day] = match;
  const eventDay = new TZDate(Number(year), Number(month) - 1, Number(day), timezone);
  return new Date(endOfDay(addDays(eventDay, ttlDays)).getTime());
}

function isActiveToken(row: Pick<AccessToken, "revokedAt" | "expiresAt">, now: Date): boolean {
  return row.revokedAt === null && row.expiresAt > now;
}

function contactKey(contact: Pick<ContactRef, "contactType" | "entityId">): string {
  return `${contact.contactType}\u0000${contact.entityId}`;
}

/** Everyone who should hold a link: active people with an email address. */
export async function listContacts(db: Db, eventId: string): Promise<ContactRef[]> {
  const [buyers, supplierRows] = await Promise.all([
    db
      .select()
      .from(participants)
      .where(and(eq(participants.eventId, eventId), eq(participants.status, "active"))),
    db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.eventId, eventId), eq(suppliers.status, "active"))),
  ]);
  const contacts: ContactRef[] = [];
  for (const b of buyers) {
    if (!b.email) continue;
    contacts.push({ contactType: "buyer", entityId: b.id, name: buyerDisplayName(b), email: b.email });
  }
  for (const s of supplierRows) {
    if (s.adminContactEmail) {
      contacts.push({
        contactType: "supplier_admin",
        entityId: s.id,
        name: s.adminContactName ?? s.name,
        email: s.adminContactEmail,
      });
    }
    if (s.attendeeContactEmail) {
      contacts.push({
        contactType: "supplier_attendee",
        entityId: s.id,
        name: s.attendeeContactName ?? s.name,
        email: s.attendeeContactEmail,
      });
    }
  }
  return contacts;
}

export async function issueTokenForContact(
  db: Db,
  input: { eventId: string; contactType: ContactType; entityId: string; expiresAt: Date },
): Promise<{ tokenId: string; token: string; expiresAt: Date }> {
  const token = generateToken();
  const [row] = await db
    .insert(accessTokens)
    .values({
      eventId: input.eventId,
      contactType: input.contactType,
      entityId: input.entityId,
      tokenHash: hashToken(token),
      expiresAt: input.expiresAt,
    })
    .returning({ id: accessTokens.id, expiresAt: accessTokens.expiresAt });
  return { tokenId: row.id, token, expiresAt: row.expiresAt };
}

async function issueForContacts(
  db: Db,
  eventId: string,
  contacts: ContactRef[],
  expiresAt: Date,
): Promise<IssuedToken[]> {
  const issued: IssuedToken[] = [];
  for (const contact of contacts) {
    const result = await issueTokenForContact(db, {
      eventId,
      contactType: contact.contactType,
      entityId: contact.entityId,
      expiresAt,
    });
    issued.push({ ...contact, ...result });
  }
  return issued;
}

/**
 * Creates a token for every contact that has no active one. Called at lock
 * time. Contacts that already hold a live token are left alone, so calling
 * this twice is safe. Returns only the newly issued plain tokens.
 */
export async function issueTokensForEvent(db: Db, eventId: string): Promise<ActionResult<IssuedToken[]>> {
  const event = await loadEvent(db, eventId);
  if (!event) return fail("not_found", "That event no longer exists.");
  const now = new Date();
  const [contacts, existing] = await Promise.all([
    listContacts(db, eventId),
    db.select().from(accessTokens).where(eq(accessTokens.eventId, eventId)),
  ]);
  const covered = new Set(existing.filter((t) => isActiveToken(t, now)).map(contactKey));
  const missing = contacts.filter((c) => !covered.has(contactKey(c)));
  const expiresAt = tokenExpiry(event.eventDate, event.timezone);
  const issued = await db.transaction((tx) => issueForContacts(tx, eventId, missing, expiresAt));
  return ok(issued);
}

/**
 * Revokes every live token of the event and issues a fresh one per contact.
 * Used when plain links are needed again (the access CSV), since the
 * database only holds hashes. Older links stop working.
 */
export async function rotateTokensForEvent(db: Db, eventId: string): Promise<ActionResult<IssuedToken[]>> {
  const event = await loadEvent(db, eventId);
  if (!event) return fail("not_found", "That event no longer exists.");
  const contacts = await listContacts(db, eventId);
  const expiresAt = tokenExpiry(event.eventDate, event.timezone);
  const issued = await db.transaction(async (tx) => {
    await tx
      .update(accessTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(accessTokens.eventId, eventId), isNull(accessTokens.revokedAt)));
    return issueForContacts(tx, eventId, contacts, expiresAt);
  });
  return ok(issued);
}

/** Revokes one token. Already revoked tokens are left as they are. Callers write the audit row. */
export async function revokeToken(db: Db, tokenId: string): Promise<ActionResult<{ tokenId: string }>> {
  const [row] = await db.select().from(accessTokens).where(eq(accessTokens.id, tokenId)).limit(1);
  if (!row) return fail("not_found", "That link no longer exists.");
  if (row.revokedAt) return ok({ tokenId: row.id });
  await db.update(accessTokens).set({ revokedAt: new Date() }).where(eq(accessTokens.id, row.id));
  return ok({ tokenId: row.id });
}

/**
 * Revokes a token and issues a new one for the same contact, with the expiry
 * recomputed from the event date. Returns the new plain token once.
 */
export async function regenerateToken(
  db: Db,
  tokenId: string,
): Promise<ActionResult<{ tokenId: string; token: string; expiresAt: Date; previousTokenId: string }>> {
  const [row] = await db.select().from(accessTokens).where(eq(accessTokens.id, tokenId)).limit(1);
  if (!row) return fail("not_found", "That link no longer exists.");
  const event = await loadEvent(db, row.eventId);
  if (!event) return fail("not_found", "That event no longer exists.");
  const expiresAt = tokenExpiry(event.eventDate, event.timezone);
  const issued = await db.transaction(async (tx) => {
    if (!row.revokedAt) {
      await tx.update(accessTokens).set({ revokedAt: new Date() }).where(eq(accessTokens.id, row.id));
    }
    return issueTokenForContact(tx, {
      eventId: row.eventId,
      contactType: row.contactType,
      entityId: row.entityId,
      expiresAt,
    });
  });
  return ok({ ...issued, previousTokenId: row.id });
}

/**
 * The contact behind a link, or null when the token is unknown, revoked, or
 * expired. Records the view. Used by `/s/[token]`.
 */
export async function verifyToken(db: Db, token: string): Promise<VerifiedToken | null> {
  if (!token || token.length > 128) return null;
  const now = new Date();
  const [row] = await db
    .select()
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.tokenHash, hashToken(token)),
        isNull(accessTokens.revokedAt),
        gt(accessTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row) return null;
  await db.update(accessTokens).set({ lastViewedAt: now }).where(eq(accessTokens.id, row.id));
  return { tokenId: row.id, eventId: row.eventId, contactType: row.contactType, entityId: row.entityId };
}
