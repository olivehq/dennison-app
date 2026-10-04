import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { participants, suppliers, type ContactType, type Event } from "@/db/schema";
import { env } from "@/lib/env";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { recipientKey, type EmailAudience } from "@/lib/schemas/email";
import { formatEventDate } from "@/lib/time";
import { compareNames } from "@/lib/names";
import { buyerDisplayName, loadEvent } from "@/server/matching/common";
import { contactKey, linkFor, linksForContacts } from "@/server/tokens/tokens";
import type { MergeValues } from "./merge";
import { changedSinceLastSend } from "./schedule-hash";

/**
 * Who a campaign goes to (scope 2.7). Contacts are active buyers and the
 * admin and attendee contacts of active suppliers, each with an email
 * address. Withdrawn people and contacts without an email never get mail.
 */

export type AudienceContact = {
  /** recipientKey(contactType, entityId) */
  key: string;
  contactType: ContactType;
  /** participants.id for buyers, suppliers.id for both supplier contacts. */
  entityId: string;
  name: string;
  email: string;
  /** Every merge value except the schedule link. */
  mergeValues: Omit<MergeValues, "schedule_link">;
};

export type Recipient = AudienceContact & {
  mergeValues: MergeValues;
  /** The access token behind `schedule_link`, or null in a preview before links exist. */
  tokenId: string | null;
};

/** Shown in previews and test sends for someone who has no link yet. Links are issued at lock. */
export const PENDING_LINK = `${env.APP_URL}/s/link-issued-at-lock`;

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

function eventValues(event: Event) {
  return { event_name: event.name, event_date: formatEventDate(event.eventDate, event.timezone) };
}

/** Every contact who can be emailed, sorted by name. */
export async function listAudienceContacts(db: Db, eventId: string): Promise<AudienceContact[] | null> {
  const event = await loadEvent(db, eventId);
  if (!event) return null;
  const [buyerRows, supplierRows] = await Promise.all([
    db
      .select()
      .from(participants)
      .where(and(eq(participants.eventId, eventId), eq(participants.status, "active"))),
    db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.eventId, eventId), eq(suppliers.status, "active"))),
  ]);
  const shared = eventValues(event);
  const contacts: AudienceContact[] = [];
  for (const b of buyerRows) {
    if (!b.email) continue;
    contacts.push({
      key: recipientKey("buyer", b.id),
      contactType: "buyer",
      entityId: b.id,
      name: buyerDisplayName(b),
      email: b.email,
      mergeValues: {
        first_name: b.firstName,
        last_name: b.lastName,
        organization: b.organization ?? "",
        supplier_name: "",
        desk: "",
        ...shared,
      },
    });
  }
  for (const s of supplierRows) {
    const people: [ContactType, string | null, string | null][] = [
      ["supplier_admin", s.adminContactName, s.adminContactEmail],
      ["supplier_attendee", s.attendeeContactName, s.attendeeContactEmail],
    ];
    for (const [contactType, contactName, email] of people) {
      if (!email) continue;
      const { first, last } = splitName(contactName ?? "");
      contacts.push({
        key: recipientKey(contactType, s.id),
        contactType,
        entityId: s.id,
        name: contactName ? `${s.name} (${contactName})` : s.name,
        email,
        mergeValues: {
          first_name: first || s.name,
          last_name: last,
          organization: s.name,
          supplier_name: s.name,
          desk: s.deskNumber === null ? "" : String(s.deskNumber),
          ...shared,
        },
      });
    }
  }
  return contacts.sort((a, b) => compareNames(a.name, b.name) || a.contactType.localeCompare(b.contactType));
}

export function filterAudience(
  contacts: AudienceContact[],
  audience: EmailAudience,
  keys: { selected?: Iterable<string>; changed?: Set<string> } = {},
): AudienceContact[] {
  switch (audience) {
    case "all":
      return contacts;
    case "buyers":
      return contacts.filter((c) => c.contactType === "buyer");
    case "suppliers":
      return contacts.filter((c) => c.contactType !== "buyer");
    case "selected": {
      const selected = new Set(keys.selected ?? []);
      return contacts.filter((c) => selected.has(c.key));
    }
    case "changed_since_last_send": {
      const changed = keys.changed ?? new Set<string>();
      return contacts.filter((c) => changed.has(c.key));
    }
  }
}

/** Adds each contact's schedule link. `issue` creates links for contacts without one; `existing` writes nothing. */
export async function withLinks(
  db: Db,
  eventId: string,
  contacts: AudienceContact[],
  links: "issue" | "existing",
): Promise<ActionResult<Recipient[]>> {
  const result = await linksForContacts(db, eventId, contacts, { issueMissing: links === "issue" });
  if (!result.ok) return result;
  return ok(
    contacts.map((c) => {
      const link = result.data.get(contactKey(c));
      return {
        ...c,
        tokenId: link?.tokenId ?? null,
        mergeValues: { ...c.mergeValues, schedule_link: link ? linkFor(link.token) : PENDING_LINK },
      };
    }),
  );
}

/**
 * The recipients of an audience with their merge values. With `links:
 * "issue"` (sending), contacts without a usable link get one (D59); with
 * `existing` (preview, test), nothing is written.
 */
export async function resolveAudience(
  db: Db,
  eventId: string,
  audience: EmailAudience,
  selectedIds: string[] = [],
  options: { links: "issue" | "existing" } = { links: "issue" },
): Promise<ActionResult<Recipient[]>> {
  const contacts = await listAudienceContacts(db, eventId);
  if (!contacts) return fail("not_found", "That event no longer exists.");
  const changed = audience === "changed_since_last_send" ? await changedSinceLastSend(db, eventId) : undefined;
  const chosen = filterAudience(contacts, audience, { selected: selectedIds, changed });
  return withLinks(db, eventId, chosen, options.links);
}
