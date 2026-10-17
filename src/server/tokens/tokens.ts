import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  accessTokens,
  participants,
  suppliers,
  type AccessToken,
  type ContactType,
  type Event,
} from "@/db/schema";
import { env } from "@/lib/env";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { endOfDayInTimezone } from "@/lib/time";
import { decryptToken, encryptToken, generateToken, hashToken } from "@/lib/tokens";
import { recordAudit } from "@/server/audit/audit";
import { ARCHIVED_MESSAGE, inEventTransaction, Refused } from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { displayNameFor } from "@/server/roster/display-name";

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
    contacts.push({ contactType: "buyer", entityId: b.id, name: displayNameFor(b), email: b.email });
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

/**
 * Gives the contact a live link and returns it. At most one unrevoked token
 * per contact exists (unique index `access_tokens_contact_live_key`), so an
 * expired one is revoked first, and when another request issued a link a
 * moment earlier that link is reused instead of failing. Safe inside a
 * transaction: the insert uses ON CONFLICT DO NOTHING, which never aborts it.
 */
export async function issueTokenForContact(
  db: Db,
  input: { eventId: string; contactType: ContactType; entityId: string; expiresAt: Date },
): Promise<{ tokenId: string; token: string; expiresAt: Date }> {
  const now = new Date();
  const contactIs = and(
    eq(accessTokens.contactType, input.contactType),
    eq(accessTokens.entityId, input.entityId),
    isNull(accessTokens.revokedAt),
  );
  await db.update(accessTokens).set({ revokedAt: now }).where(and(contactIs, lte(accessTokens.expiresAt, now)));

  for (let attempt = 0; attempt < 2; attempt++) {
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
      .onConflictDoNothing({
        target: [accessTokens.contactType, accessTokens.entityId],
        where: sql`${accessTokens.revokedAt} is null`,
      })
      .returning({ id: accessTokens.id, expiresAt: accessTokens.expiresAt });
    if (row) return { tokenId: row.id, token, expiresAt: row.expiresAt };

    const [live] = await db.select().from(accessTokens).where(contactIs).limit(1);
    const plain = live?.tokenCiphertext ? decryptToken(live.tokenCiphertext) : null;
    if (live && plain) return { tokenId: live.id, token: plain, expiresAt: live.expiresAt };
    // A link from before D59 can't be handed out again: retire it and retry once.
    if (live) await db.update(accessTokens).set({ revokedAt: now }).where(eq(accessTokens.id, live.id));
  }
  throw new Error(`Could not issue a link for ${input.contactType} ${input.entityId}.`);
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

/** Each contact's newest token, keyed by `contactKey`. */
function newestTokens(rows: AccessToken[]): Map<string, AccessToken> {
  const newest = new Map<string, AccessToken>();
  for (const row of rows) {
    const key = contactKey(row);
    if (isNewerToken(row, newest.get(key))) newest.set(key, row);
  }
  return newest;
}

/**
 * Creates a token for every contact who never had one or whose newest token
 * expired. Called at lock time. Contacts that already hold a live token are
 * left alone, so calling this twice is safe. A contact whose newest token is
 * revoked gets nothing (D137): only Regenerate gives them a link again.
 * Returns only the newly issued plain tokens.
 */
export async function issueTokensForEvent(db: Db, eventId: string): Promise<ActionResult<IssuedToken[]>> {
  const event = await getEvent(eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const now = new Date();
  const [contacts, existing] = await Promise.all([
    listContacts(db, eventId),
    db.select().from(accessTokens).where(eq(accessTokens.eventId, eventId)),
  ]);
  const newest = newestTokens(existing);
  const missing = contacts.filter((c) => {
    const row = newest.get(contactKey(c));
    return !row || (row.revokedAt === null && !isActiveToken(row, now));
  });
  const expiresAt = tokenExpiry(event.eventDate, event.timezone);
  const issued = await db.transaction((tx) => issueForContacts(tx, eventId, missing, expiresAt));
  return ok(issued);
}

export type ContactLink = { tokenId: string; token: string };

export type ContactLinks = {
  /** Each contact's working link, keyed by `contactKey`. */
  links: Map<string, ContactLink>;
  /** Contacts whose newest link was revoked. They get no link here; Regenerate on the roster gives them one. */
  revoked: Set<string>;
  /** How many contacts got a new link from this call. Always 0 without `issueMissing`. */
  issued: number;
};

/** True when `row` is a newer token for the contact than `current`; at an equal time a live token wins. */
export function isNewerToken(
  row: Pick<AccessToken, "createdAt" | "revokedAt">,
  current: Pick<AccessToken, "createdAt" | "revokedAt"> | undefined,
): boolean {
  return (
    !current ||
    row.createdAt > current.createdAt ||
    (row.createdAt.getTime() === current.createdAt.getTime() && row.revokedAt === null && current.revokedAt !== null)
  );
}

/**
 * The current link of each contact (D59), from the contact's newest token. A
 * live token is reused when its ciphertext decrypts. A revoked newest token
 * is respected: the contact is listed in `revoked` and never gets a new link
 * here, since an admin revoked it on purpose. With `issueMissing`, a contact
 * who never had a link or whose link expired gets a new one, and a live token
 * from before D59 (no ciphertext) is revoked and replaced, since its plain
 * value is gone. Without `issueMissing` nothing is written and those contacts
 * are absent from `links`. Callers audit what they did with the links.
 */
export async function linksForContacts(
  db: Db,
  eventId: string,
  contacts: Pick<ContactRef, "contactType" | "entityId">[],
  options: { issueMissing: boolean },
): Promise<ActionResult<ContactLinks>> {
  const event = await getEvent(eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const now = new Date();
  const rows = await db.select().from(accessTokens).where(eq(accessTokens.eventId, eventId));
  const newest = newestTokens(rows);

  const links = new Map<string, ContactLink>();
  const revoked = new Set<string>();
  const missing: Pick<ContactRef, "contactType" | "entityId">[] = [];
  const unreadable: string[] = [];
  for (const contact of contacts) {
    const key = contactKey(contact);
    if (links.has(key) || revoked.has(key)) continue;
    const row = newest.get(key);
    if (row?.revokedAt) {
      revoked.add(key);
      continue;
    }
    const live = row && isActiveToken(row, now) ? row : undefined;
    const token = live?.tokenCiphertext ? decryptToken(live.tokenCiphertext) : null;
    if (live && token) {
      links.set(key, { tokenId: live.id, token });
    } else {
      missing.push(contact);
      if (live) unreadable.push(live.id);
    }
  }
  if (!options.issueMissing || missing.length === 0) return ok({ links, revoked, issued: 0 });

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
  return ok({ links, revoked, issued: missing.length });
}

const tokenIdSchema = z.uuid();

type TokenContext = { row: AccessToken; event: Event };

const WITHDRAWN_MESSAGE = "This person has withdrawn. Restore them before giving them a new link.";

/**
 * Loads a token for a link action, refusing archived events and, unless
 * `allowWithdrawn`, people who withdrew. Links are allowed on locked and sent
 * events (AGENTS.md, "locked event" exceptions).
 */
async function loadTokenForChange(
  db: Db,
  tokenId: unknown,
  options: { allowWithdrawn: boolean },
): Promise<ActionResult<TokenContext>> {
  const parsed = tokenIdSchema.safeParse(tokenId);
  if (!parsed.success) return fail("not_found", "That link no longer exists.");
  const [row] = await db.select().from(accessTokens).where(eq(accessTokens.id, parsed.data)).limit(1);
  if (!row) return fail("not_found", "That link no longer exists.");
  const event = await getEvent(row.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (event.status === "archived") return fail("locked", ARCHIVED_MESSAGE);
  if (!options.allowWithdrawn && (await contactStatus(db, row)) !== "active") {
    return fail("conflict", WITHDRAWN_MESSAGE);
  }
  return ok({ row, event });
}

/**
 * Runs a link change in a transaction that takes the event row while it is
 * not archived (archive and roster withdrawals take the same row), then
 * re-reads the person, so the checks of `loadTokenForChange` hold under the lock.
 */
function inLinkTransaction<T>(
  db: Db,
  row: Pick<AccessToken, "eventId" | "contactType" | "entityId">,
  options: { allowWithdrawn: boolean },
  work: (tx: Db) => Promise<T>,
): Promise<ActionResult<T>> {
  return inEventTransaction(db, row.eventId, "unarchived", async (tx) => {
    if (!options.allowWithdrawn && (await contactStatus(tx, row)) !== "active") {
      throw new Refused(fail("conflict", WITHDRAWN_MESSAGE));
    }
    return work(tx);
  });
}

async function contactStatus(db: Db, row: Pick<AccessToken, "contactType" | "entityId">): Promise<string | null> {
  if (row.contactType === "buyer") {
    const [p] = await db.select({ status: participants.status }).from(participants).where(eq(participants.id, row.entityId)).limit(1);
    return p?.status ?? null;
  }
  const [s] = await db.select({ status: suppliers.status }).from(suppliers).where(eq(suppliers.id, row.entityId)).limit(1);
  return s?.status ?? null;
}

/**
 * Revokes one token and audits it in the same transaction. Already revoked
 * tokens are left as they are. Allowed for a withdrawn person, since it only
 * removes access; refused on an archived event.
 */
export async function revokeToken(
  db: Db,
  tokenId: unknown,
  adminId: string | null,
): Promise<ActionResult<{ tokenId: string; eventId: string }>> {
  const loaded = await loadTokenForChange(db, tokenId, { allowWithdrawn: true });
  if (!loaded.ok) return loaded;
  const { row } = loaded.data;
  if (row.revokedAt) return ok({ tokenId: row.id, eventId: row.eventId });
  const done = await inLinkTransaction(db, row, { allowWithdrawn: true }, async (tx) => {
    const changed = await tx
      .update(accessTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(accessTokens.id, row.id), isNull(accessTokens.revokedAt)))
      .returning({ id: accessTokens.id });
    if (changed.length === 0) return;
    await recordAudit(tx, {
      eventId: row.eventId,
      adminId,
      action: "token.revoke",
      entityType: "access_token",
      entityId: row.id,
      after: { contactType: row.contactType, entityId: row.entityId },
    });
  });
  if (!done.ok) return done;
  return ok({ tokenId: row.id, eventId: row.eventId });
}

/**
 * Revokes the contact's live links and issues a new one, with the expiry
 * recomputed from the event date, then audits it, all in one transaction.
 * Refused for a withdrawn person or an archived event. Returns the new plain
 * token once.
 */
export async function regenerateToken(
  db: Db,
  tokenId: unknown,
  adminId: string | null,
): Promise<
  ActionResult<{ tokenId: string; token: string; expiresAt: Date; previousTokenId: string; eventId: string }>
> {
  const loaded = await loadTokenForChange(db, tokenId, { allowWithdrawn: false });
  if (!loaded.ok) return loaded;
  const { row, event } = loaded.data;
  const expiresAt = tokenExpiry(event.eventDate, event.timezone);
  const issued = await inLinkTransaction(db, row, { allowWithdrawn: false }, async (tx) => {
    await tx
      .update(accessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(accessTokens.contactType, row.contactType),
          eq(accessTokens.entityId, row.entityId),
          isNull(accessTokens.revokedAt),
        ),
      );
    const fresh = await issueTokenForContact(tx, {
      eventId: row.eventId,
      contactType: row.contactType,
      entityId: row.entityId,
      expiresAt,
    });
    await recordAudit(tx, {
      eventId: row.eventId,
      adminId,
      action: "token.regenerate",
      entityType: "access_token",
      entityId: fresh.tokenId,
      before: { tokenId: row.id },
      after: { contactType: row.contactType, entityId: row.entityId, expiresAt: fresh.expiresAt },
    });
    return fresh;
  });
  if (!issued.ok) return issued;
  return ok({ ...issued.data, previousTokenId: row.id, eventId: row.eventId });
}

export type VerifyTokenOptions = {
  /**
   * Runs the `lastViewedAt` write. `/s/[token]` passes Next's `after()` so the
   * write happens once the page is sent. Without it the write is awaited.
   */
  defer?: (task: () => Promise<unknown>) => void;
};

/**
 * The contact behind a link, or null when the token is unknown, revoked, or
 * expired. Records the view. Used by `/s/[token]`.
 */
export async function verifyToken(
  db: Db,
  token: string,
  options: VerifyTokenOptions = {},
): Promise<VerifiedToken | null> {
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
  const recordView = async () => {
    await db.update(accessTokens).set({ lastViewedAt: now }).where(eq(accessTokens.id, row.id));
  };
  if (options.defer) options.defer(recordView);
  else await recordView();
  return { tokenId: row.id, eventId: row.eventId, contactType: row.contactType, entityId: row.entityId };
}
