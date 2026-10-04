import { asc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { accessTokens, participants, suppliers, type ContactType } from "@/db/schema";
import type { ActionResult } from "@/lib/errors";
import { ok } from "@/lib/errors";
import { buyerDisplayName, compareNames } from "@/server/matching/common";
import { linkFor, rotateTokensForEvent } from "./tokens";

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
        name = buyerDisplayName(buyer);
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
 * This is a write, not a read. The database stores only token hashes, so the
 * only way to print a working link for everyone is to issue a new token for
 * every contact. Calling it revokes every live link of the event and returns
 * fresh ones; links sent earlier stop working. Callers must audit the call.
 */
export async function issueAccessList(db: Db, eventId: string): Promise<ActionResult<AccessListRow[]>> {
  const rotated = await rotateTokensForEvent(db, eventId);
  if (!rotated.ok) return rotated;
  const rows = rotated.data
    .map((t) => ({ name: t.name, email: t.email, contactType: t.contactType, link: linkFor(t.token) }))
    .sort((a, b) => compareNames(a.name, b.name) || a.contactType.localeCompare(b.contactType));
  return ok(rows);
}
