import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { adminInvites, admins } from "@/db/schema";
import { hashToken } from "./admins";

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
      .from(admins)
      .orderBy(asc(admins.name)),
    db
      .select({
        id: adminInvites.id,
        email: adminInvites.email,
        name: adminInvites.name,
        createdAt: adminInvites.createdAt,
        expiresAt: adminInvites.expiresAt,
        invitedBy: adminInvites.invitedBy,
        inviterName: admins.name,
      })
      .from(adminInvites)
      .leftJoin(admins, eq(admins.id, adminInvites.invitedBy))
      .where(isNull(adminInvites.acceptedAt))
      .orderBy(asc(adminInvites.createdAt)),
  ]);
  return {
    admins: adminRows,
    invites: inviteRows.map((row) => ({ ...row, expired: row.expiresAt <= now })),
  };
}

export type InviteByToken = {
  id: string;
  email: string;
  name: string;
  expiresAt: Date;
};

/** The pending, unexpired invite behind a link token, or null. */
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
        gt(adminInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invite ?? null;
}
