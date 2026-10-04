import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { accounts, admins } from "@/db/schema";

/**
 * Writes an admin directly (D28): an `admins` row plus a credential
 * `accounts` row with the password hashed the way Better Auth hashes it.
 * Shared by `pnpm create-admin` and `pnpm db:seed`. Callers validate input.
 */

export async function findAdminId(db: Db, email: string): Promise<string | null> {
  const [row] = await db.select({ id: admins.id }).from(admins).where(eq(admins.email, email)).limit(1);
  return row?.id ?? null;
}

export async function createAdminAccount(
  db: Db,
  input: { email: string; name: string; password: string },
): Promise<string> {
  const id = randomUUID();
  const hashed = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    await tx.insert(admins).values({ id, name: input.name.trim(), email: input.email, emailVerified: true });
    await tx.insert(accounts).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: hashed,
    });
  });
  return id;
}
