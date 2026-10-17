import { asc, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { accessTokens, participants, suppliers, type ContactType } from "@/db/schema";
import { ok, type ActionResult } from "@/lib/errors";
import { compareNames } from "@/lib/names";
import { decryptToken } from "@/lib/tokens";
import { displayNameFor } from "@/server/roster/display-name";
import { claimEvent } from "@/server/events/editable";
import { contactKey, isNewerToken, linkFor, linksForContacts, listContacts } from "./tokens";

export type TokenStatus = "active" | "revoked" | "expired";

export type TokenListItem = {
  id: string;
  contactType: ContactType;
  entityId: string;
  name: string;
  email: string | null;
  status: TokenStatus;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastViewedAt: Date | null;
};

/** Every token of the event for the roster pages. Never includes the token itself. */
export async function listTokens(eventId: string, db: Db = getDb()): Promise<TokenListItem[]> {
  const now = new Date();
  const [rows, buyers, supplierRows] = await Promise.all([
    db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.eventId, eventId))
      .orderBy(asc(accessTokens.createdAt)),
    db.select().from(participants).where(eq(participants.eventId, eventId)),
    db.select().from(suppliers).where(eq(suppliers.eventId, eventId)),
  ]);
  const buyerById = new Map(buyers.map((b) => [b.id, b]));
  const supplierById = new Map(supplierRows.map((s) => [s.id, s]));

  const items: TokenListItem[] = rows.map((row) => {
    let name = "Unknown contact";
    let email: string | null = null;
    if (row.contactType === "buyer") {
      const buyer = buyerById.get(row.entityId);
      if (buyer) {
        name = displayNameFor(buyer);
        email = buyer.email;
      }
    } else {
      const supplier = supplierById.get(row.entityId);
      if (supplier) {
        const isAdmin = row.contactType === "supplier_admin";
        const contactName = isAdmin ? supplier.adminContactName : supplier.attendeeContactName;
        name = contactName ? `${supplier.name} (${contactName})` : supplier.name;
        email = isAdmin ? supplier.adminContactEmail : supplier.attendeeContactEmail;
      }
    }
    const status: TokenStatus = row.revokedAt ? "revoked" : row.expiresAt <= now ? "expired" : "active";
    return {
      id: row.id,
      contactType: row.contactType,
      entityId: row.entityId,
      name,
      email,
      status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastViewedAt: row.lastViewedAt,
    };
  });
  return items.sort((a, b) => compareNames(a.name, b.name) || a.contactType.localeCompare(b.contactType));
}

export type AccessListRow = {
  name: string;
  email: string;
  contactType: ContactType;
  /** The buyer's organization, or the supplier's name for a supplier contact. */
  company: string;
  /** The buyer's title. Null for supplier contacts. */
  title: string | null;
  /** The contact's newest link after this call; absent when they never had one. */
  link: ReadLink | undefined;
};

export type AccessList = {
  rows: AccessListRow[];
  /** Contacts who got a new link from this call. */
  linksIssued: number;
};

/**
 * Rows for the participant access CSV (scope 2.4, the email fallback).
 *
 * Each contact's current link is reused (D31, D59), so links already emailed
 * keep working. Contacts who never had a link, or whose link expired, get a
 * new one, which makes this a write: call it inside the transaction that
 * writes the audit row, so a failed audit rolls the new links back. A revoked
 * link stays revoked: that contact's row says so. On an archived event
 * nothing is issued and each row shows the link as stored.
 */
export async function issueAccessList(db: Db, eventId: string): Promise<ActionResult<AccessList>> {
  const contacts = await listContacts(db, eventId);
  const issued = await db.transaction(async (tx) => {
    // Archive refuses link changes (D89); the row lock keeps one from landing mid-issue.
    if (!(await claimEvent(tx, eventId, "unarchived"))) return ok(null);
    return linksForContacts(tx, eventId, contacts, { issueMissing: true });
  });
  if (!issued.ok) return issued;
  const [links, buyers, supplierRows] = await Promise.all([
    readContactLinks(db, eventId, { withUrls: true }),
    db.select().from(participants).where(eq(participants.eventId, eventId)),
    db.select().from(suppliers).where(eq(suppliers.eventId, eventId)),
  ]);
  const buyerById = new Map(buyers.map((b) => [b.id, b]));
  const supplierById = new Map(supplierRows.map((s) => [s.id, s]));
  const rows = contacts
    .map((c) => {
      const buyer = c.contactType === "buyer" ? buyerById.get(c.entityId) : undefined;
      return {
        name: c.name,
        email: c.email,
        contactType: c.contactType,
        company: buyer ? (buyer.organization ?? "") : (supplierById.get(c.entityId)?.name ?? ""),
        title: buyer?.title ?? null,
        link: links.get(contactKey(c)),
      };
    })
    .sort((a, b) => compareNames(a.name, b.name) || a.contactType.localeCompare(b.contactType));
  return ok({ rows, linksIssued: issued.data?.issued ?? 0 });
}

/** A contact's newest link as stored: its token id, state and, for a live link, the URL (when asked for and readable). */
export type ReadLink = { tokenId: string; status: TokenStatus; url: string | null };

/**
 * The newest token of every contact of the event, keyed by `contactKey`. Never
 * writes. With `withUrls`, a live token's ciphertext is decrypted the same way
 * `linksForContacts` does, so exports can print the link people already hold;
 * a live token from before D59 (no ciphertext) comes back with `url: null`.
 * Contacts that never had a token are absent.
 */
export async function readContactLinks(
  db: Db,
  eventId: string,
  options: { withUrls: boolean },
  now: Date = new Date(),
): Promise<Map<string, ReadLink>> {
  // Only the columns the newest-token rule and the state need; ciphertext only when links are printed.
  const rows = await db
    .select({
      id: accessTokens.id,
      contactType: accessTokens.contactType,
      entityId: accessTokens.entityId,
      createdAt: accessTokens.createdAt,
      expiresAt: accessTokens.expiresAt,
      revokedAt: accessTokens.revokedAt,
      tokenCiphertext: options.withUrls ? accessTokens.tokenCiphertext : sql<string | null>`null`,
    })
    .from(accessTokens)
    .where(eq(accessTokens.eventId, eventId));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = contactKey(row);
    // At an equal timestamp a live token beats a retired one, as on the roster pages.
    if (isNewerToken(row, newest.get(key))) newest.set(key, row);
  }
  const links = new Map<string, ReadLink>();
  for (const [key, row] of newest) {
    const status: TokenStatus = row.revokedAt ? "revoked" : row.expiresAt <= now ? "expired" : "active";
    const plain = status === "active" && options.withUrls && row.tokenCiphertext ? decryptToken(row.tokenCiphertext) : null;
    links.set(key, { tokenId: row.id, status, url: plain ? linkFor(plain) : null });
  }
  return links;
}
