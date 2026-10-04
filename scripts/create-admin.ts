/**
 * Creates the first admin account without an invite.
 *
 *   pnpm create-admin you@example.com "Your Name"
 *
 * The password comes from ADMIN_PASSWORD, or from a prompt that doesn't echo
 * it. It is never taken as an argument: arguments end up in shell history and
 * in the process list other users on the machine can read.
 *
 * Invites need an inviting admin, so the very first account is written
 * directly: an `admins` row plus a credential `accounts` row with the password
 * hashed the way Better Auth hashes it. Later admins come through the Team page.
 */
import { createInterface } from "node:readline";
import { closeDb, getDb } from "@/db/client";
import { emailSchema } from "@/lib/schemas/roster";
import { passwordSchema } from "@/lib/schemas/auth";
import { createAdminAccount, findAdminId } from "./seed/admin";

const USAGE = 'Usage: pnpm create-admin <email> "<name>"   (password from ADMIN_PASSWORD, or you are prompted)';

/** Asks for a line without echoing what is typed. */
function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // readline has no public option to hide input; muting its writer after the
  // question is printed is the usual way.
  const writer = rl as unknown as { _writeToOutput: (text: string) => void };
  let muted = false;
  const write = writer._writeToOutput.bind(rl);
  writer._writeToOutput = (text) => {
    if (!muted) write(text);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

async function readPassword(): Promise<string | null> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!process.stdin.isTTY) {
    console.error("Set ADMIN_PASSWORD, or run this in a terminal to be prompted for the password.");
    return null;
  }
  const password = await promptHidden("Password (10+ characters): ");
  const again = await promptHidden("Password again: ");
  if (password !== again) {
    console.error("The two passwords don't match.");
    return null;
  }
  return password;
}

async function main() {
  const [rawEmail, name, ...extra] = process.argv.slice(2);
  if (extra.length > 0) {
    console.error(
      "Don't pass the password as an argument: it stays in shell history and the process list. Set ADMIN_PASSWORD or answer the prompt instead.",
    );
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!rawEmail || !name) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const email = emailSchema.safeParse(rawEmail);
  if (!email.success) {
    console.error(`Not a valid email: ${rawEmail}`);
    process.exitCode = 1;
    return;
  }
  const password = await readPassword();
  if (password === null) {
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
  if (await findAdminId(db, email.data)) {
    console.error(`${email.data} already has an account. Use the Team page or password reset instead.`);
    process.exitCode = 1;
    return;
  }

  await createAdminAccount(db, { email: email.data, name, password: checkedPassword.data });
  console.log(`Created admin ${email.data}. Sign in at ${process.env.APP_URL ?? "http://localhost:3000"}/login`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
