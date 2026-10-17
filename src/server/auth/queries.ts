import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { adminInvites, admins, sessions } from "@/db/schema";
import { compareNames } from "@/lib/names";
import { hashToken } from "./admins";
import { describeUserAgent } from "./user-agent";

export type AdminListItem = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  disabledAt: Date | null;
  invitedBy: string | null;
};

export type PendingInvite = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  expired: boolean;
  revoked: boolean;
  invitedBy: string;
  inviterName: string | null;
};

export async function listAdmins(
  db: Db = getDb(),
): Promise<{ admins: AdminListItem[]; invites: PendingInvite[] }> {
  const now = new Date();
  const [adminRows, inviteRows] = await Promise.all([
    db
      .select({
        id: admins.id,
        name: admins.name,
        email: admins.email,
        createdAt: admins.createdAt,
        disabledAt: admins.disabledAt,
        invitedBy: admins.invitedBy,
      })
      .from(admins),
    db
      .select({
        id: adminInvites.id,
        email: adminInvites.email,
        name: adminInvites.name,
        createdAt: adminInvites.createdAt,
        expiresAt: adminInvites.expiresAt,
        revokedAt: adminInvites.revokedAt,
        invitedBy: adminInvites.invitedBy,
        inviterName: admins.name,
      })
      .from(adminInvites)
      .leftJoin(admins, eq(admins.id, adminInvites.invitedBy))
      .where(isNull(adminInvites.acceptedAt))
      .orderBy(asc(adminInvites.createdAt)),
  ]);
  return {
    admins: adminRows.sort((a, b) => compareNames(a.name, b.name)),
    invites: inviteRows.map(({ revokedAt, ...row }) => ({
      ...row,
      expired: row.expiresAt <= now,
      revoked: revokedAt !== null,
    })),
  };
}

export type InviteByToken = {
  id: string;
  email: string;
  name: string;
  expiresAt: Date;
};

/** The pending, unexpired, unrevoked invite behind a link token, or null. */
export async function getInviteByToken(
  token: string,
  db: Db = getDb(),
): Promise<InviteByToken | null> {
  const [invite] = await db
    .select({
      id: adminInvites.id,
      email: adminInvites.email,
      name: adminInvites.name,
      expiresAt: adminInvites.expiresAt,
    })
    .from(adminInvites)
    .where(
      and(
        eq(adminInvites.tokenHash, hashToken(token)),
        isNull(adminInvites.acceptedAt),
        isNull(adminInvites.revokedAt),
        gt(adminInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invite ?? null;
}

export type AdminSessionItem = {
  id: string;
  /** "Chrome on macOS", from the user agent. The raw string, token, and IP stay on the server. */
  device: string;
  signedInAt: Date;
  /** Better Auth moves this forward when it refreshes the session (at most hourly, D73). */
  lastActiveAt: Date;
  current: boolean;
};

/** The admin's unexpired sessions, this browser first, then the most recently active. */
export async function listAdminSessions(
  input: { adminId: string; currentSessionId: string },
  db: Db = getDb(),
): Promise<AdminSessionItem[]> {
  const rows = await db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, input.adminId), gt(sessions.expiresAt, new Date())));
  return rows
    .map((row) => ({
      id: row.id,
      device: describeUserAgent(row.userAgent),
      signedInAt: row.createdAt,
      lastActiveAt: row.updatedAt,
      current: row.id === input.currentSessionId,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
}
