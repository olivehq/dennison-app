import { asc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { accessTokens, participants, suppliers, type ContactType } from "@/db/schema";
import type { ActionResult } from "@/lib/errors";
import { ok } from "@/lib/errors";
import { compareNames } from "@/lib/names";
import { displayNameFor } from "@/server/roster/display-name";
import { contactKey, linkFor, linksForContacts, listContacts } from "./tokens";

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
  link: string;
};

/**
 * Rows for the participant access CSV (scope 2.4, the email fallback).
 *
 * Each contact's current link is reused (D31, D59), so links already emailed
 * keep working. Only contacts with no usable link get a new token, which makes
 * this a write. Callers must audit the call.
 */
export async function issueAccessList(db: Db, eventId: string): Promise<ActionResult<AccessListRow[]>> {
  const contacts = await listContacts(db, eventId);
  const links = await linksForContacts(db, eventId, contacts, { issueMissing: true });
  if (!links.ok) return links;
  const rows = contacts
    .map((c) => ({ name: c.name, email: c.email, contactType: c.contactType, link: linkFor(links.data.get(contactKey(c))!.token) }))
    .sort((a, b) => compareNames(a.name, b.name) || a.contactType.localeCompare(b.contactType));
  return ok(rows);
}
