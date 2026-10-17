import type { Db } from "@/db/client";
import { readContactLinks, type ReadLink } from "@/server/tokens/queries";
import { recipientKey } from "@/lib/schemas/email";
import { listContacts, type Contact, type ContactRef } from "@/server/tokens/tokens";

/**
 * The schedule link line(s) printed under each person's schedule in the
 * schedules ZIP. Read only: it reuses a live link by decrypting the stored
 * ciphertext (D59) and never issues one, so downloading the ZIP changes
 * nothing.
 */

export type LinkRow = { label: string; value: string };

/** Keyed by `personLinkKey`. A person without an entry has no contact that could hold a link. */
export type PersonLinkRows = ReadonlyMap<string, LinkRow[]>;

export const NO_LINK = "No link generated";
export const LINK_REVOKED = "Link revoked";
export const LINK_EXPIRED = "Link expired";
export const LINK_UNREADABLE = "Link unavailable, regenerate it on the roster page";

export function personLinkKey(type: "buyer" | "supplier", id: string): string {
  return `${type}:${id}`;
}

/** What goes in the value cell: the URL of a live link, else why there is none. */
export function linkValue(link: ReadLink | undefined): string {
  if (!link) return NO_LINK;
  switch (link.status) {
    case "active":
      return link.url ?? LINK_UNREADABLE;
    case "revoked":
      return LINK_REVOKED;
    case "expired":
      return LINK_EXPIRED;
  }
}

type LinkContact = Pick<ContactRef, "contactType" | "entityId" | "name"> & Partial<Pick<Contact, "supplier">>;

/** The file is already one supplier's schedule, so the label names the contact alone, not "Supplier (Contact)". */
function labelFor(contact: LinkContact): string {
  switch (contact.contactType) {
    case "buyer":
      return "Schedule link";
    case "supplier_admin":
      return `Admin schedule link (${contact.supplier?.adminContactName || contact.name})`;
    case "supplier_attendee":
      return `Attendee schedule link (${contact.supplier?.attendeeContactName || contact.name})`;
  }
}

/** One row per contact, grouped by person: a buyer has one, a supplier up to two (`listContacts` lists admin, then attendee). */
export function buildLinkRows(
  contacts: LinkContact[],
  links: ReadonlyMap<string, ReadLink>,
): PersonLinkRows {
  const rows = new Map<string, LinkRow[]>();
  for (const contact of contacts) {
    const key = personLinkKey(contact.contactType === "buyer" ? "buyer" : "supplier", contact.entityId);
    const list = rows.get(key) ?? [];
    list.push({ label: labelFor(contact), value: linkValue(links.get(recipientKey(contact.contactType, contact.entityId))) });
    rows.set(key, list);
  }
  return rows;
}

export async function loadLinkRows(db: Db, eventId: string): Promise<PersonLinkRows> {
  const [contacts, links] = await Promise.all([
    listContacts(db, eventId),
    readContactLinks(db, eventId, { withUrls: true }),
  ]);
  return buildLinkRows(contacts, links);
}
