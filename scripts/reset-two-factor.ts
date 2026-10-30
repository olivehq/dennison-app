/**
 * Turns off two-factor sign-in for an admin who lost both their authenticator
 * app and their backup codes, and signs them out everywhere (D189).
 *
 *   pnpm reset-two-factor dana@example.com
 *
 * Runs against DATABASE_URL (or local PGlite when unset), like create-admin.
 * Confirm who is asking before running it: it removes their second factor.
 */
import { closeDb, getDb } from "@/db/client";
import { emailSchema } from "@/lib/schemas/roster";
import { resetTwoFactor } from "@/server/auth/admins";

async function main() {
  const [rawEmail, ...extra] = process.argv.slice(2);
  const email = emailSchema.safeParse(rawEmail ?? "");
  if (!email.success || extra.length > 0) {
    console.error("Usage: pnpm reset-two-factor <email>");
    process.exitCode = 1;
    return;
  }
  const result = await resetTwoFactor(getDb(), email.data);
  if (!result) {
    console.error(`No admin has the email ${email.data}.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    result.wasEnabled
      ? `Two-factor sign-in is off for ${email.data}, and they are signed out everywhere. They sign in with their password, then can turn it on again from Profile.`
      : `${email.data} did not have two-factor sign-in on. They are signed out everywhere.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
