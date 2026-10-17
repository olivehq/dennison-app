import type { Db } from "@/db/client";
import type { Event } from "@/db/schema";
import { env } from "@/lib/env";
import { fail, ok, type ActionResult } from "@/lib/errors";
import type { EmailAudience } from "@/lib/schemas/email";
import { formatEventDate } from "@/lib/time";
import { compareNames } from "@/lib/names";
import { getEvent } from "@/server/events/queries";
import { linkFor, linksForContacts, listContacts, type ContactRef } from "@/server/tokens/tokens";
import type { MergeValues } from "./merge";
import { changedSinceLastSend } from "./schedule-hash";

/**
 * Who a campaign goes to (scope 2.7). Contacts are active buyers and the
 * admin and attendee contacts of active suppliers, each with an email
 * address. Withdrawn people and contacts without an email never get mail.
 */

export type AudienceContact = ContactRef & {
  /** Every merge value except the schedule link. */
  mergeValues: Omit<MergeValues, "schedule_link">;
};

export type Recipient = AudienceContact & {
  mergeValues: MergeValues;
  /** The access token behind `schedule_link`, or null in a preview before links exist, or when the link was revoked. */
  tokenId: string | null;
  /** The contact's newest link was revoked. Sends skip them; Regenerate on the roster gives them a new link. */
  linkRevoked: boolean;
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

/** Every contact who can be emailed (`listContacts`), with merge values, sorted by name. */
export async function listAudienceContacts(db: Db, eventId: string): Promise<AudienceContact[] | null> {
  const event = await getEvent(eventId, db);
  if (!event) return null;
  const shared = eventValues(event);
  const contacts = await listContacts(db, eventId);
  return contacts
    .map(({ buyer, supplier, ...c }): AudienceContact => {
      if (buyer) {
        return {
          ...c,
          mergeValues: {
            first_name: buyer.firstName,
            last_name: buyer.lastName,
            organization: buyer.organization ?? "",
            supplier_name: "",
            desk: "",
            ...shared,
          },
        };
      }
      const contactName = c.contactType === "supplier_admin" ? supplier!.adminContactName : supplier!.attendeeContactName;
      const { first, last } = splitName(contactName ?? "");
      return {
        ...c,
        mergeValues: {
          first_name: first || supplier!.name,
          last_name: last,
          organization: supplier!.name,
          supplier_name: supplier!.name,
          desk: supplier!.deskNumber === null ? "" : String(supplier!.deskNumber),
          ...shared,
        },
      };
    })
    .sort((a, b) => compareNames(a.name, b.name) || a.contactType.localeCompare(b.contactType));
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

/**
 * Adds each contact's schedule link. `issue` creates links for contacts who
 * never had one or whose link expired; `existing` writes nothing. Neither
 * gives a contact with a revoked link a new one: they come back with
 * `linkRevoked` set and the pending link.
 */
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
      const link = result.data.links.get(c.key);
      return {
        ...c,
        tokenId: link?.tokenId ?? null,
        linkRevoked: result.data.revoked.has(c.key),
        mergeValues: { ...c.mergeValues, schedule_link: link ? linkFor(link.token) : PENDING_LINK },
      };
    }),
  );
}

/** The contacts an audience covers, without links. Only `changed_since_last_send` reads more than the contacts. */
export async function audienceContactsFor(
  db: Db,
  eventId: string,
  contacts: AudienceContact[],
  audience: EmailAudience,
  selectedIds: string[] = [],
): Promise<AudienceContact[]> {
  const changed = audience === "changed_since_last_send" ? await changedSinceLastSend(db, eventId) : undefined;
  return filterAudience(contacts, audience, { selected: selectedIds, changed });
}

/**
 * The recipients of an audience with their merge values. With `links:
 * "issue"` (sending), contacts without a usable link get one (D59), except
 * those whose link was revoked (`linkRevoked`); with `existing` (preview,
 * test), nothing is written.
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
  const chosen = await audienceContactsFor(db, eventId, contacts, audience, selectedIds);
  return withLinks(db, eventId, chosen, options.links);
}
