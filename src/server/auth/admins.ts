import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { adminInvites, admins, sessions, type AdminInvite } from "@/db/schema";
import { sendEmail } from "@/lib/email/adapter";
import { env } from "@/lib/env";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { recordAudit } from "@/server/audit/audit";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function inviteUrl(token: string): string {
  return `${env.APP_URL}/invite/${token}`;
}

export async function findPendingInvite(db: Db, email: string): Promise<AdminInvite | null> {
  const [invite] = await db
    .select()
    .from(adminInvites)
    .where(
      and(
        eq(adminInvites.email, email.toLowerCase()),
        isNull(adminInvites.acceptedAt),
        gt(adminInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invite ?? null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function sendInviteEmail(invite: { email: string; name: string }, token: string, inviterName: string) {
  const url = inviteUrl(token);
  await sendEmail({
    to: invite.email,
    from: env.EMAIL_FROM,
    subject: `${inviterName} invited you to the AW Appointment Show admin`,
    html: `<p>Hi ${escapeHtml(invite.name)},</p><p>${escapeHtml(inviterName)} invited you to help run the AW Appointment Show schedule. The link works for 7 days.</p><p><a href="${url}">Accept the invitation</a></p>`,
    text: `Hi ${invite.name},\n\n${inviterName} invited you to help run the AW Appointment Show schedule. The link works for 7 days.\n\n${url}`,
    tags: { kind: "admin_invite" },
  });
}

async function getAdminName(db: Db, adminId: string): Promise<string> {
  const [row] = await db.select({ name: admins.name }).from(admins).where(eq(admins.id, adminId));
  return row?.name ?? "A colleague";
}

export async function createInvite(
  db: Db,
  input: { email: string; name: string; invitedBy: string },
): Promise<ActionResult<{ inviteId: string }>> {
  const email = input.email.toLowerCase();

  const [existingAdmin] = await db.select({ id: admins.id }).from(admins).where(eq(admins.email, email));
  if (existingAdmin) {
    return fail("conflict", "That person already has an account.", {
      email: ["That person already has an account."],
    });
  }
  if (await findPendingInvite(db, email)) {
    return fail("conflict", "That person already has a pending invite. Resend it instead.", {
      email: ["Already invited. Use Resend."],
    });
  }

  const { token, tokenHash } = generateToken();
  const invite = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(adminInvites)
      .values({
        email,
        name: input.name,
        tokenHash,
        invitedBy: input.invitedBy,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    await recordAudit(tx, {
      eventId: null,
      adminId: input.invitedBy,
      action: "admin.invite",
      entityType: "admin_invite",
      entityId: row.id,
      after: { email, name: input.name, expiresAt: row.expiresAt },
    });
    return row;
  });

  try {
    await sendInviteEmail(invite, token, await getAdminName(db, input.invitedBy));
  } catch {
    return fail("internal", "The invite was saved but the email did not send. Try resending it.");
  }
  return ok({ inviteId: invite.id });
}

export async function resendInvite(
  db: Db,
  input: { inviteId: string; actorId: string },
): Promise<ActionResult<{ inviteId: string }>> {
  const [invite] = await db.select().from(adminInvites).where(eq(adminInvites.id, input.inviteId));
  if (!invite) return fail("not_found", "That invite no longer exists.");
  if (invite.acceptedAt) return fail("conflict", "That invite was already accepted.");

  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.transaction(async (tx) => {
    await tx.update(adminInvites).set({ tokenHash, expiresAt }).where(eq(adminInvites.id, invite.id));
    await recordAudit(tx, {
      eventId: null,
      adminId: input.actorId,
      action: "admin.invite_resend",
      entityType: "admin_invite",
      entityId: invite.id,
      before: { expiresAt: invite.expiresAt },
      after: { expiresAt },
    });
  });

  try {
    await sendInviteEmail(invite, token, await getAdminName(db, input.actorId));
  } catch {
    return fail("internal", "The invite was refreshed but the email did not send. Try again.");
  }
  return ok({ inviteId: invite.id });
}

export async function disableAdminAccount(
  db: Db,
  input: { userId: string; actorId: string },
): Promise<ActionResult<{ userId: string }>> {
  if (input.userId === input.actorId) {
    return fail("validation", "You can't disable your own account. Ask a colleague to do it.");
  }
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(admins).where(eq(admins.id, input.userId));
    if (!target) return fail("not_found", "That admin no longer exists.");
    if (target.disabledAt) return ok({ userId: target.id });

    const [{ others }] = await tx
      .select({ others: count() })
      .from(admins)
      .where(and(isNull(admins.disabledAt), ne(admins.id, target.id)));
    if (others === 0) {
      return fail("conflict", "This is the last active admin. Invite someone else before disabling it.");
    }

    const disabledAt = new Date();
    await tx.update(admins).set({ disabledAt }).where(eq(admins.id, target.id));
    await tx.delete(sessions).where(eq(sessions.userId, target.id));
    await recordAudit(tx, {
      eventId: null,
      adminId: input.actorId,
      action: "admin.disable",
      entityType: "admin",
      entityId: target.id,
      before: { disabledAt: null },
      after: { disabledAt, email: target.email },
    });
    return ok({ userId: target.id });
  });
}

export async function enableAdminAccount(
  db: Db,
  input: { userId: string; actorId: string },
): Promise<ActionResult<{ userId: string }>> {
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(admins).where(eq(admins.id, input.userId));
    if (!target) return fail("not_found", "That admin no longer exists.");
    if (!target.disabledAt) return ok({ userId: target.id });

    await tx.update(admins).set({ disabledAt: null }).where(eq(admins.id, target.id));
    await recordAudit(tx, {
      eventId: null,
      adminId: input.actorId,
      action: "admin.enable",
      entityType: "admin",
      entityId: target.id,
      before: { disabledAt: target.disabledAt },
      after: { disabledAt: null, email: target.email },
    });
    return ok({ userId: target.id });
  });
}
