import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  accessTokens,
  participants,
  suppliers,
  type ContactType,
  type Participant,
  type Supplier,
} from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import type { ParticipantInput, SupplierInput } from "@/lib/schemas/roster";
import { recordAudit } from "@/server/audit/audit";
import { loadEditableEvent } from "./editable";

type Actor = { adminId: string };

export type UpsertParticipantInput = Actor & {
  eventId: string;
  /** Omit to create. */
  id?: string;
  data: ParticipantInput;
};

export type UpsertSupplierInput = Actor & {
  eventId: string;
  id?: string;
  data: SupplierInput;
};

export type ByIdInput = Actor & { id: string };

/** Marks every live link for this person as revoked. The tokens module issues new ones. */
export async function revokeTokens(
  db: Db,
  input: { eventId: string; entityId: string; contactTypes: ContactType[] },
): Promise<number> {
  let revoked = 0;
  for (const contactType of input.contactTypes) {
    const rows = await db
      .update(accessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(accessTokens.eventId, input.eventId),
          eq(accessTokens.contactType, contactType),
          eq(accessTokens.entityId, input.entityId),
          isNull(accessTokens.revokedAt),
        ),
      )
      .returning({ id: accessTokens.id });
    revoked += rows.length;
  }
  return revoked;
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

async function findParticipant(db: Db, id: string): Promise<Participant | null> {
  const [row] = await db.select().from(participants).where(eq(participants.id, id)).limit(1);
  return row ?? null;
}

async function emailTaken(db: Db, eventId: string, email: string, exceptId?: string): Promise<boolean> {
  const conditions = [eq(participants.eventId, eventId), eq(participants.email, email)];
  if (exceptId) conditions.push(ne(participants.id, exceptId));
  const [row] = await db.select({ id: participants.id }).from(participants).where(and(...conditions)).limit(1);
  return row !== undefined;
}

function participantValues(data: ParticipantInput) {
  return {
    email: data.email,
    firstName: data.firstName,
    lastName: data.lastName,
    organization: data.organization ?? null,
    title: data.title ?? null,
    displayName: data.displayName ?? null,
    biztechOptIn: data.biztechOptIn,
  };
}

export async function upsertParticipant(
  db: Db,
  input: UpsertParticipantInput,
): Promise<ActionResult<{ id: string }>> {
  const loaded = await loadEditableEvent(db, input.eventId);
  if (!loaded.ok) return loaded.error;

  const existing = input.id ? await findParticipant(db, input.id) : null;
  if (input.id && (!existing || existing.eventId !== input.eventId)) {
    return fail("not_found", "That participant no longer exists.");
  }
  if (await emailTaken(db, input.eventId, input.data.email, existing?.id)) {
    return fail("conflict", "Another participant in this event already uses that email.", {
      email: ["Already used by another participant."],
    });
  }

  const values = participantValues(input.data);
  const saved = await db.transaction(async (tx) => {
    if (!existing) {
      const [row] = await tx.insert(participants).values({ eventId: input.eventId, ...values }).returning();
      await recordAudit(tx, {
        eventId: input.eventId,
        adminId: input.adminId,
        action: "participant.create",
        entityType: "participant",
        entityId: row.id,
        after: row,
      });
      return row;
    }
    const [row] = await tx.update(participants).set(values).where(eq(participants.id, existing.id)).returning();
    const emailChanged = existing.email !== row.email;
    const revoked = emailChanged
      ? await revokeTokens(tx, { eventId: input.eventId, entityId: row.id, contactTypes: ["buyer"] })
      : 0;
    await recordAudit(tx, {
      eventId: input.eventId,
      adminId: input.adminId,
      action: "participant.update",
      entityType: "participant",
      entityId: row.id,
      before: existing,
      after: row,
      note: emailChanged ? `Email changed; ${revoked} link${revoked === 1 ? "" : "s"} revoked.` : null,
    });
    return row;
  });
  return ok({ id: saved.id });
}

async function setParticipantStatus(
  db: Db,
  input: ByIdInput,
  status: Participant["status"],
): Promise<ActionResult<{ id: string }>> {
  const existing = await findParticipant(db, input.id);
  if (!existing) return fail("not_found", "That participant no longer exists.");
  const loaded = await loadEditableEvent(db, existing.eventId);
  if (!loaded.ok) return loaded.error;
  if (existing.status === status) return ok({ id: existing.id });

  // Rankings and appointments stay; the schedule flags the gaps and restore reverses it.
  await db.transaction(async (tx) => {
    const [row] = await tx.update(participants).set({ status }).where(eq(participants.id, existing.id)).returning();
    await recordAudit(tx, {
      eventId: existing.eventId,
      adminId: input.adminId,
      action: status === "withdrawn" ? "participant.withdraw" : "participant.restore",
      entityType: "participant",
      entityId: row.id,
      before: { status: existing.status },
      after: { status: row.status },
    });
  });
  return ok({ id: existing.id });
}

export function withdrawParticipant(db: Db, input: ByIdInput): Promise<ActionResult<{ id: string }>> {
  return setParticipantStatus(db, input, "withdrawn");
}

export function restoreParticipant(db: Db, input: ByIdInput): Promise<ActionResult<{ id: string }>> {
  return setParticipantStatus(db, input, "active");
}

export async function setBiztechOptIn(
  db: Db,
  input: ByIdInput & { optIn: boolean },
): Promise<ActionResult<{ id: string }>> {
  const existing = await findParticipant(db, input.id);
  if (!existing) return fail("not_found", "That participant no longer exists.");
  const loaded = await loadEditableEvent(db, existing.eventId);
  if (!loaded.ok) return loaded.error;
  if (existing.biztechOptIn === input.optIn) return ok({ id: existing.id });

  await db.transaction(async (tx) => {
    await tx.update(participants).set({ biztechOptIn: input.optIn }).where(eq(participants.id, existing.id));
    await recordAudit(tx, {
      eventId: existing.eventId,
      adminId: input.adminId,
      action: "participant.biztech_opt_in",
      entityType: "participant",
      entityId: existing.id,
      before: { biztechOptIn: existing.biztechOptIn },
      after: { biztechOptIn: input.optIn },
    });
  });
  return ok({ id: existing.id });
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

async function findSupplier(db: Db, id: string): Promise<Supplier | null> {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  return row ?? null;
}

async function nameTaken(db: Db, eventId: string, name: string, exceptId?: string): Promise<boolean> {
  const conditions = [eq(suppliers.eventId, eventId), eq(suppliers.name, name)];
  if (exceptId) conditions.push(ne(suppliers.id, exceptId));
  const [row] = await db.select({ id: suppliers.id }).from(suppliers).where(and(...conditions)).limit(1);
  return row !== undefined;
}

function supplierValues(data: SupplierInput) {
  return {
    name: data.name,
    type: data.type,
    adminContactName: data.adminContact?.name ?? null,
    adminContactEmail: data.adminContact?.email ?? null,
    attendeeContactName: data.attendeeContact?.name ?? null,
    attendeeContactEmail: data.attendeeContact?.email ?? null,
  };
}

/** Contact types whose email changed, so their links must be revoked. */
function changedContacts(before: Supplier, after: Supplier): ContactType[] {
  const changed: ContactType[] = [];
  if (before.adminContactEmail !== after.adminContactEmail) changed.push("supplier_admin");
  if (before.attendeeContactEmail !== after.attendeeContactEmail) changed.push("supplier_attendee");
  return changed;
}

export async function upsertSupplier(db: Db, input: UpsertSupplierInput): Promise<ActionResult<{ id: string }>> {
  const loaded = await loadEditableEvent(db, input.eventId);
  if (!loaded.ok) return loaded.error;

  const existing = input.id ? await findSupplier(db, input.id) : null;
  if (input.id && (!existing || existing.eventId !== input.eventId)) {
    return fail("not_found", "That supplier no longer exists.");
  }
  if (await nameTaken(db, input.eventId, input.data.name, existing?.id)) {
    return fail("conflict", "Another supplier in this event already has that name.", {
      name: ["Already used by another supplier."],
    });
  }

  const values = supplierValues(input.data);
  const saved = await db.transaction(async (tx) => {
    if (!existing) {
      const [row] = await tx.insert(suppliers).values({ eventId: input.eventId, ...values }).returning();
      await recordAudit(tx, {
        eventId: input.eventId,
        adminId: input.adminId,
        action: "supplier.create",
        entityType: "supplier",
        entityId: row.id,
        after: row,
      });
      return row;
    }
    const [row] = await tx.update(suppliers).set(values).where(eq(suppliers.id, existing.id)).returning();
    const contactTypes = changedContacts(existing, row);
    const revoked = contactTypes.length
      ? await revokeTokens(tx, { eventId: input.eventId, entityId: row.id, contactTypes })
      : 0;
    await recordAudit(tx, {
      eventId: input.eventId,
      adminId: input.adminId,
      action: "supplier.update",
      entityType: "supplier",
      entityId: row.id,
      before: existing,
      after: row,
      note: contactTypes.length ? `Contact email changed; ${revoked} link${revoked === 1 ? "" : "s"} revoked.` : null,
    });
    return row;
  });
  return ok({ id: saved.id });
}

async function setSupplierStatus(
  db: Db,
  input: ByIdInput,
  status: Supplier["status"],
): Promise<ActionResult<{ id: string }>> {
  const existing = await findSupplier(db, input.id);
  if (!existing) return fail("not_found", "That supplier no longer exists.");
  const loaded = await loadEditableEvent(db, existing.eventId);
  if (!loaded.ok) return loaded.error;
  if (existing.status === status) return ok({ id: existing.id });

  await db.transaction(async (tx) => {
    const [row] = await tx.update(suppliers).set({ status }).where(eq(suppliers.id, existing.id)).returning();
    await recordAudit(tx, {
      eventId: existing.eventId,
      adminId: input.adminId,
      action: status === "withdrawn" ? "supplier.withdraw" : "supplier.restore",
      entityType: "supplier",
      entityId: row.id,
      before: { status: existing.status },
      after: { status: row.status },
    });
  });
  return ok({ id: existing.id });
}

export function withdrawSupplier(db: Db, input: ByIdInput): Promise<ActionResult<{ id: string }>> {
  return setSupplierStatus(db, input, "withdrawn");
}

export function restoreSupplier(db: Db, input: ByIdInput): Promise<ActionResult<{ id: string }>> {
  return setSupplierStatus(db, input, "active");
}

/**
 * A number sets a manual desk that survives lock-time assignment (D17);
 * null clears it so the alphabetical rule applies again.
 */
export async function setSupplierDesk(
  db: Db,
  input: ByIdInput & { deskNumber: number | null },
): Promise<ActionResult<{ id: string }>> {
  const existing = await findSupplier(db, input.id);
  if (!existing) return fail("not_found", "That supplier no longer exists.");
  const loaded = await loadEditableEvent(db, existing.eventId);
  if (!loaded.ok) return loaded.error;

  if (input.deskNumber !== null) {
    const [taken] = await db
      .select({ name: suppliers.name })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.eventId, existing.eventId),
          eq(suppliers.deskNumber, input.deskNumber),
          eq(suppliers.status, "active"),
          ne(suppliers.id, existing.id),
        ),
      )
      .limit(1);
    if (taken) {
      return fail("conflict", `Desk ${input.deskNumber} is already assigned to ${taken.name}.`, {
        deskNumber: [`Already assigned to ${taken.name}.`],
      });
    }
  }

  const values = { deskNumber: input.deskNumber, deskOverride: input.deskNumber !== null };
  await db.transaction(async (tx) => {
    await tx.update(suppliers).set(values).where(eq(suppliers.id, existing.id));
    await recordAudit(tx, {
      eventId: existing.eventId,
      adminId: input.adminId,
      action: "supplier.desk",
      entityType: "supplier",
      entityId: existing.id,
      before: { deskNumber: existing.deskNumber, deskOverride: existing.deskOverride },
      after: values,
    });
  });
  return ok({ id: existing.id });
}
