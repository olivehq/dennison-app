/**
 * Builds the demo event from the real 2025 results.
 *
 *   pnpm db:migrate && pnpm db:seed
 *
 * Works on PGlite (no DATABASE_URL, stop `pnpm dev` first, D26) and on
 * Postgres. Safe to re-run: the demo event is deleted and rebuilt, the demo
 * admin is created only once.
 */
import { closeDb, getDb, PGLITE_DATA_DIR } from "@/db/client";
import { DEMO_ADMIN, DEMO_EVENT_NAME, seedDemo, seedTargetRefusal } from "./seed/demo";
import { loadFixture } from "./seed/fixture";

async function main() {
  const refusal = seedTargetRefusal(process.env);
  if (refusal) {
    console.error(`Not seeding: ${refusal}`);
    process.exitCode = 1;
    return;
  }
  const target = process.env.DATABASE_URL ? "DATABASE_URL" : `PGlite (${PGLITE_DATA_DIR})`;
  console.log(`Seeding the demo event into ${target}`);
  const summary = await seedDemo(getDb(), loadFixture());
  if (summary.replacedEvents > 0) console.log("Replaced the existing demo event.");
  console.log(
    `Created ${DEMO_EVENT_NAME}: ${summary.participants} participants, ${summary.suppliers} suppliers, ` +
      `${summary.rankings} rankings, ${summary.appointments} appointments in the active run.`,
  );
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  console.log("");
  console.log(`Sign in at ${appUrl}/login`);
  console.log(`  Email:    ${DEMO_ADMIN.email}`);
  console.log(
    summary.adminCreated
      ? `  Password: ${DEMO_ADMIN.password}`
      : `  Password: unchanged (the account already existed; the demo password is ${DEMO_ADMIN.password} if you never changed it)`,
  );
  console.log(`  Event:    ${appUrl}/events/${summary.eventId}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
