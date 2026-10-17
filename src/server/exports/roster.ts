import { and, desc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { compareNames } from "@/lib/names";
import { recipientKey } from "@/lib/schemas/email";
import { formatTimestamp } from "@/lib/time";
import { getScheduleChangeState } from "@/server/email/queries";
import type { ScheduleChangeState } from "@/server/email/schedule-hash";
import { getEvent } from "@/server/events/queries";
import { findActiveRun } from "@/server/matching/runs";
import { listParticipants, listSuppliers } from "@/server/roster/queries";
import { readContactLinks, type ReadLink } from "@/server/tokens/queries";
import { contactKey } from "@/server/tokens/tokens";
import { toCsv } from "./common";

/**
 * The full participant and supplier lists (`AW_<year>_Participants_Full.csv`,
 * `AW_<year>_Suppliers_Full.csv`). Unlike the schedule files they include
 * everyone, withdrawn people too, with the stored values as they stand now
 * (manual edits included). They hold no token, hash, or ciphertext, only the
 * state of each contact's link.
 */

export const PARTICIPANT_FULL_COLUMNS = [
  "First name",
  "Last name",
  "Email",
  "Organization",
  "Title",
  "Display name",
  "Biztech opt-in",
  "Status",
  "Withdrawn on",
  "Appointments",
  "Link",
  "Changed since last email",
  "Created",
  "Updated",
];

export const SUPPLIER_FULL_COLUMNS = [
  "Name",
  "Type",
  "Desk",
  "Desk set by hand",
  "Admin contact name",
  "Admin contact email",
  "Attendee contact name",
  "Attendee contact email",
  "Status",
  "Withdrawn on",
  "Appointments",
  "Admin link",
  "Attendee link",
  "Changed since last email",
  "Created",
  "Updated",
];

const LINK_LABELS = { active: "Link active", revoked: "Revoked", expired: "Expired" } as const;

/** A contact's link state in the words of the roster pages. Blank for a contact with no email, since it cannot hold a link. */
function linkLabel(link: ReadLink | undefined, email: string | null): string {
  if (!email) return "";
  return link ? LINK_LABELS[link.status] : "No link";
}

type ChangeLabel = "Changed" | "Up to date" | "";

function changeLabel(state: ScheduleChangeState, key: string): ChangeLabel {
  if (state.changed.has(key)) return "Changed";
  return state.emailed.has(key) ? "Up to date" : "";
}

/** The most recent time each person was withdrawn, from the activity log. Absent for people withdrawn any other way. */
async function withdrawnAt(
  db: Db,
  eventId: string,
  action: "participant.withdraw" | "supplier.withdraw",
): Promise<Map<string, Date>> {
  const rows = await db
    .select({ entityId: auditEvents.entityId, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.eventId, eventId), eq(auditEvents.action, action)))
    .orderBy(desc(auditEvents.createdAt));
  const latest = new Map<string, Date>();
  for (const row of rows) if (row.entityId && !latest.has(row.entityId)) latest.set(row.entityId, row.createdAt);
  return latest;
}

export type RosterCsv = { csv: string; count: number };

/** Everyone who was ever added, sorted by last then first name. Appointments are blank until a run is active. */
export async function participantsFullCsv(eventId: string, db: Db = getDb()): Promise<ActionResult<RosterCsv>> {
  const event = await getEvent(eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const [people, run, links, changes, withdrawn] = await Promise.all([
    listParticipants(eventId, { includeWithdrawn: true }, db),
    findActiveRun(db, eventId),
    readContactLinks(db, eventId, { withUrls: false }),
    getScheduleChangeState(eventId, db),
    withdrawnAt(db, eventId, "participant.withdraw"),
  ]);
  const when = (instant: Date) => formatTimestamp(instant, event.timezone);
  const rows = [...people]
    .sort(
      (a, b) =>
        compareNames(a.lastName, b.lastName) || compareNames(a.firstName, b.firstName) || compareNames(a.email, b.email),
    )
    .map((p) => {
      const withdrawnOn = p.status === "withdrawn" ? withdrawn.get(p.id) : undefined;
      return [
        p.firstName,
        p.lastName,
        p.email,
        p.organization ?? "",
        p.title ?? "",
        p.displayName ?? "",
        p.biztechOptIn ? "Yes" : "No",
        p.status === "active" ? "Active" : "Withdrawn",
        withdrawnOn ? when(withdrawnOn) : "",
        run ? p.appointmentCount : "",
        linkLabel(links.get(contactKey({ contactType: "buyer", entityId: p.id })), p.email),
        changeLabel(changes, recipientKey("buyer", p.id)),
        when(p.createdAt),
        when(p.updatedAt),
      ];
    });
  return ok({ csv: toCsv(PARTICIPANT_FULL_COLUMNS, rows), count: rows.length });
}

/** Every supplier, withdrawn included, sorted by name, with one link state per contact. */
export async function suppliersFullCsv(eventId: string, db: Db = getDb()): Promise<ActionResult<RosterCsv>> {
  const event = await getEvent(eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const [list, run, links, changes, withdrawn] = await Promise.all([
    listSuppliers(eventId, { includeWithdrawn: true }, db),
    findActiveRun(db, eventId),
    readContactLinks(db, eventId, { withUrls: false }),
    getScheduleChangeState(eventId, db),
    withdrawnAt(db, eventId, "supplier.withdraw"),
  ]);
  const when = (instant: Date) => formatTimestamp(instant, event.timezone);
  const rows = [...list]
    .sort((a, b) => compareNames(a.name, b.name))
    .map((s) => {
      const withdrawnOn = s.status === "withdrawn" ? withdrawn.get(s.id) : undefined;
      // One state per supplier, as on the Suppliers page: changed beats up to date beats never emailed.
      const states = [
        changeLabel(changes, recipientKey("supplier_admin", s.id)),
        changeLabel(changes, recipientKey("supplier_attendee", s.id)),
      ];
      return [
        s.name,
        s.type === "hotel" ? "Hotel" : "Business",
        s.deskNumber ?? "",
        s.deskOverride ? "Yes" : "No",
        s.adminContactName ?? "",
        s.adminContactEmail ?? "",
        s.attendeeContactName ?? "",
        s.attendeeContactEmail ?? "",
        s.status === "active" ? "Active" : "Withdrawn",
        withdrawnOn ? when(withdrawnOn) : "",
        run ? s.appointmentCount : "",
        linkLabel(links.get(contactKey({ contactType: "supplier_admin", entityId: s.id })), s.adminContactEmail),
        linkLabel(links.get(contactKey({ contactType: "supplier_attendee", entityId: s.id })), s.attendeeContactEmail),
        states.includes("Changed") ? "Changed" : states.includes("Up to date") ? "Up to date" : "",
        when(s.createdAt),
        when(s.updatedAt),
      ];
    });
  return ok({ csv: toCsv(SUPPLIER_FULL_COLUMNS, rows), count: rows.length });
}
