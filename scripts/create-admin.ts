/**
 * Creates the first admin account without an invite.
 *
 *   pnpm create-admin you@example.com "Your Name" "a-password-of-10-chars-or-more"
 *
 * Invites need an inviting admin, so the very first account is written
 * directly: an `admins` row plus a credential `accounts` row with the password
 * hashed the way Better Auth hashes it. Later admins come through the Team page.
 */
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { accounts, admins } from "@/db/schema";
import { emailSchema } from "@/lib/schemas/roster";
import { passwordSchema } from "@/lib/schemas/auth";

async function main() {
  const [rawEmail, name, password] = process.argv.slice(2);
  if (!rawEmail || !name || !password) {
    console.error('Usage: pnpm create-admin <email> "<name>" <password>');
    process.exitCode = 1;
    return;
  }
  const email = emailSchema.safeParse(rawEmail);
  if (!email.success) {
    console.error(`Not a valid email: ${rawEmail}`);
    process.exitCode = 1;
    return;
  }
  const checkedPassword = passwordSchema.safeParse(password);
  if (!checkedPassword.success) {
    console.error(checkedPassword.error.issues.map((i) => i.message).join(" "));
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const [existing] = await db.select({ id: admins.id }).from(admins).where(eq(admins.email, email.data));
  if (existing) {
    console.error(`${email.data} already has an account. Use the Team page or password reset instead.`);
    process.exitCode = 1;
    return;
  }

  const id = randomUUID();
  const hashed = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.insert(admins).values({ id, name: name.trim(), email: email.data, emailVerified: true });
    await tx.insert(accounts).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: hashed,
    });
  });
  console.log(`Created admin ${email.data}. Sign in at ${process.env.APP_URL ?? "http://localhost:3000"}/login`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
