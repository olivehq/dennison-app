import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { adminInvites, admins, sessions, type AdminInvite } from "@/db/schema";
import { isEmailConfigured, sendEmail } from "@/lib/email/adapter";
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

/** `delivered` is false when no email provider is set up and the message was only logged. */
export type InviteSent = { inviteId: string; delivered: boolean };

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
        isNull(adminInvites.revokedAt),
        gt(adminInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invite ?? null;
}

/**
 * The pending, unexpired, unrevoked invite whose token hashes to `token_hash` and whose
 * email matches. Sign-up requires this: knowing an invited email is not enough.
 */
export async function findPendingInviteByToken(
  db: Db,
  email: string,
  token: string,
): Promise<AdminInvite | null> {
  const [invite] = await db
    .select()
    .from(adminInvites)
    .where(
      and(
        eq(adminInvites.tokenHash, hashToken(token)),
        eq(adminInvites.email, email.toLowerCase()),
        isNull(adminInvites.acceptedAt),
        isNull(adminInvites.revokedAt),
        gt(adminInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invite ?? null;
}

/**
 * Marks the invite for this email and token accepted, only while it is still
 * pending and unexpired, and audits it in the same transaction. One UPDATE
 * with those conditions is the compare-and-set: it waits for a concurrent
 * `revokeInvite` (which holds the row) and then re-checks the expiry.
 * Returns false when the invite is gone, used, revoked, or expired.
 */
export async function acceptInvite(
  db: Db,
  input: { email: string; token: string; user: { id: string; name: string } },
): Promise<boolean> {
  const email = input.email.toLowerCase();
  return db.transaction(async (tx) => {
    const now = new Date();
    const [accepted] = await tx
      .update(adminInvites)
      .set({ acceptedAt: now })
      .where(
        and(
          eq(adminInvites.tokenHash, hashToken(input.token)),
          eq(adminInvites.email, email),
          isNull(adminInvites.acceptedAt),
          isNull(adminInvites.revokedAt),
          gt(adminInvites.expiresAt, now),
        ),
      )
      .returning({ id: adminInvites.id });
    if (!accepted) return false;
    await recordAudit(tx, {
      eventId: null,
      adminId: input.user.id,
      action: "admin.accept_invite",
      entityType: "admin",
      entityId: input.user.id,
      after: { email, name: input.user.name },
    });
    return true;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Sends the invite and says whether it really went out. Without an email
 * provider the logger adapter only logs a redacted line, so in development
 * (never production, never tests) the accept link goes to the server console;
 * otherwise a local invite could not be accepted. No other link is logged.
 */
async function sendInviteEmail(
  invite: { email: string; name: string },
  token: string,
  inviterName: string,
): Promise<{ delivered: boolean }> {
  const url = inviteUrl(token);
  const delivered = isEmailConfigured();
  await sendEmail({
    to: invite.email,
    from: env.EMAIL_FROM,
    subject: `${inviterName} invited you to the AW Appointment Show admin`,
    html: `<p>Hi ${escapeHtml(invite.name)},</p><p>${escapeHtml(inviterName)} invited you to help run the AW Appointment Show schedule. The link works for 7 days.</p><p><a href="${url}">Accept the invitation</a></p>`,
    text: `Hi ${invite.name},\n\n${inviterName} invited you to help run the AW Appointment Show schedule. The link works for 7 days.\n\n${url}`,
    tags: { kind: "admin_invite" },
  });
  if (!delivered && env.NODE_ENV === "development") {
    console.log(`[email] dev invite link for ${invite.email}: ${url}`);
  }
  return { delivered };
}

async function getAdminName(db: Db, adminId: string): Promise<string> {
  const [row] = await db.select({ name: admins.name }).from(admins).where(eq(admins.id, adminId));
  return row?.name ?? "A colleague";
}

export async function createInvite(
  db: Db,
  input: { email: string; name: string; invitedBy: string },
): Promise<ActionResult<InviteSent>> {
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

  let delivered: boolean;
  try {
    ({ delivered } = await sendInviteEmail(invite, token, await getAdminName(db, input.invitedBy)));
  } catch {
    return fail("internal", "The invite was saved but the email did not send. Try resending it.");
  }
  return ok({ inviteId: invite.id, delivered });
}

export async function resendInvite(
  db: Db,
  input: { inviteId: string; actorId: string },
): Promise<ActionResult<InviteSent>> {
  const [invite] = await db.select().from(adminInvites).where(eq(adminInvites.id, input.inviteId));
  if (!invite) return fail("not_found", "That invite no longer exists.");
  if (invite.acceptedAt) return fail("conflict", "That invite was already accepted.");
  if (invite.revokedAt) return fail("conflict", "That invite was revoked. Send a new invite instead.");

  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const refreshed = await db.transaction(async (tx) => {
    // Matching on revoked_at keeps a revoke that lands after the read above final.
    const updated = await tx
      .update(adminInvites)
      .set({ tokenHash, expiresAt })
      .where(and(eq(adminInvites.id, invite.id), isNull(adminInvites.revokedAt)))
      .returning({ id: adminInvites.id });
    if (updated.length === 0) return false;
    await recordAudit(tx, {
      eventId: null,
      adminId: input.actorId,
      action: "admin.invite_resend",
      entityType: "admin_invite",
      entityId: invite.id,
      before: { expiresAt: invite.expiresAt },
      after: { expiresAt },
    });
    return true;
  });
  if (!refreshed) return fail("conflict", "That invite was revoked. Send a new invite instead.");

  let delivered: boolean;
  try {
    ({ delivered } = await sendInviteEmail(invite, token, await getAdminName(db, input.actorId)));
  } catch {
    return fail("internal", "The invite was refreshed but the email did not send. Try again.");
  }
  return ok({ inviteId: invite.id, delivered });
}

/**
 * Stops a pending invite's link from working for good: it expires now and is
 * marked revoked, so resend refuses it. Revoking an invite that already
 * expired is a no-op; an accepted one is refused. To invite the person after
 * all, send a new invite.
 */
export async function revokeInvite(
  db: Db,
  input: { inviteId: string; actorId: string },
): Promise<ActionResult<{ inviteId: string }>> {
  return db.transaction(async (tx) => {
    const [invite] = await tx.select().from(adminInvites).where(eq(adminInvites.id, input.inviteId)).for("update");
    if (!invite) return fail("not_found", "That invite no longer exists.");
    if (invite.acceptedAt) return fail("conflict", "That invite was already accepted. Disable the account instead.");
    const now = new Date();
    if (invite.expiresAt <= now) return ok({ inviteId: invite.id });

    await tx.update(adminInvites).set({ expiresAt: now, revokedAt: now }).where(eq(adminInvites.id, invite.id));
    await recordAudit(tx, {
      eventId: null,
      adminId: input.actorId,
      action: "admin.invite_revoke",
      entityType: "admin_invite",
      entityId: invite.id,
      before: { email: invite.email, expiresAt: invite.expiresAt },
      after: { email: invite.email, expiresAt: now },
    });
    return ok({ inviteId: invite.id });
  });
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

    // Two concurrent disables of different admins must not both see the other
    // as still active. Lock the active admins in id order (no deadlock), then
    // set disabled_at in one conditional UPDATE that only matches while another
    // active admin exists. Zero rows updated means this was the last one.
    await tx.select({ id: admins.id }).from(admins).where(isNull(admins.disabledAt)).orderBy(admins.id).for("update");
    const disabledAt = new Date();
    const updated = await tx
      .update(admins)
      .set({ disabledAt })
      .where(
        and(
          eq(admins.id, target.id),
          isNull(admins.disabledAt),
          sql`exists (select 1 from ${admins} as other where other.disabled_at is null and other.id <> ${target.id})`,
        ),
      )
      .returning({ id: admins.id });
    if (updated.length === 0) {
      return fail("conflict", "This is the last active admin. Invite someone else before disabling it.");
    }

    await tx.delete(sessions).where(eq(sessions.userId, target.id));
    // Their pending invites stop working too; a colleague can resend one that should stand.
    const expired = await tx
      .update(adminInvites)
      .set({ expiresAt: disabledAt })
      .where(
        and(
          eq(adminInvites.invitedBy, target.id),
          isNull(adminInvites.acceptedAt),
          gt(adminInvites.expiresAt, disabledAt),
        ),
      )
      .returning({ id: adminInvites.id });
    await recordAudit(tx, {
      eventId: null,
      adminId: input.actorId,
      action: "admin.disable",
      entityType: "admin",
      entityId: target.id,
      before: { disabledAt: null },
      after: { disabledAt, email: target.email, invitesRevoked: expired.length },
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
