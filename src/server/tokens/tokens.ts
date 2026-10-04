import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
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
import { endOfDayInTimezone } from "@/lib/time";
import { decryptToken, encryptToken, generateToken, hashToken } from "@/lib/tokens";
import { buyerDisplayName, loadEvent } from "@/server/matching/common";

/**
 * Participant access links (D14, scope 2.6). One token per contact: every
 * active buyer, and each active supplier's admin and attendee contact. The
 * plain token is returned by the function that issued it and stored only
 * encrypted (D59), so `linksForContacts` can hand the same link out again.
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The later of the end of the day 60 days after the event, in the event's
 * timezone (D14, D16), and 60 days from `now`. The second keeps links issued
 * or rotated after a past event date from expiring on the spot.
 */
export function tokenExpiry(
  eventDate: string,
  timezone: string,
  now: Date = new Date(),
  ttlDays = TOKEN_TTL_DAYS,
): Date {
  const afterEvent = endOfDayInTimezone(eventDate, timezone, ttlDays);
  const fromNow = new Date(now.getTime() + ttlDays * DAY_MS);
  return afterEvent > fromNow ? afterEvent : fromNow;
}

function isActiveToken(row: Pick<AccessToken, "revokedAt" | "expiresAt">, now: Date): boolean {
  return row.revokedAt === null && row.expiresAt > now;
}

export function contactKey(contact: Pick<ContactRef, "contactType" | "entityId">): string {
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
      tokenCiphertext: encryptToken(token),
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

export type ContactLink = { tokenId: string; token: string };

/**
 * The current link of each contact, keyed by `contactKey` (D59). A contact's
 * newest active token is reused when its ciphertext decrypts. With
 * `issueMissing`, contacts with no usable token get a new one; an active token
 * from before D59 (no ciphertext) is revoked first, since its plain value is
 * gone. Without `issueMissing` nothing is written and those contacts are
 * absent from the map. Callers audit what they did with the links.
 */
export async function linksForContacts(
  db: Db,
  eventId: string,
  contacts: Pick<ContactRef, "contactType" | "entityId">[],
  options: { issueMissing: boolean },
): Promise<ActionResult<Map<string, ContactLink>>> {
  const event = await loadEvent(db, eventId);
  if (!event) return fail("not_found", "That event no longer exists.");
  const now = new Date();
  const rows = await db
    .select()
    .from(accessTokens)
    .where(eq(accessTokens.eventId, eventId))
    .orderBy(desc(accessTokens.createdAt));
  const newestActive = new Map<string, AccessToken>();
  for (const row of rows) {
    const key = contactKey(row);
    if (isActiveToken(row, now) && !newestActive.has(key)) newestActive.set(key, row);
  }

  const links = new Map<string, ContactLink>();
  const missing: Pick<ContactRef, "contactType" | "entityId">[] = [];
  const unreadable: string[] = [];
  for (const contact of contacts) {
    const key = contactKey(contact);
    if (links.has(key)) continue;
    const row = newestActive.get(key);
    const token = row?.tokenCiphertext ? decryptToken(row.tokenCiphertext) : null;
    if (row && token) {
      links.set(key, { tokenId: row.id, token });
    } else {
      missing.push(contact);
      if (row) unreadable.push(row.id);
    }
  }
  if (!options.issueMissing || missing.length === 0) return ok(links);

  const expiresAt = tokenExpiry(event.eventDate, event.timezone);
  await db.transaction(async (tx) => {
    if (unreadable.length > 0) {
      await tx.update(accessTokens).set({ revokedAt: now }).where(inArray(accessTokens.id, unreadable));
    }
    for (const contact of missing) {
      const issued = await issueTokenForContact(tx, {
        eventId,
        contactType: contact.contactType,
        entityId: contact.entityId,
        expiresAt,
      });
      links.set(contactKey(contact), { tokenId: issued.tokenId, token: issued.token });
    }
  });
  return ok(links);
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
