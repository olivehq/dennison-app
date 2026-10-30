import { closeDb, getDb, PGLITE_DATA_DIR } from "@/db/client";
import { migrate } from "@/db/migrate";

async function main() {
  // On Vercel a missing DATABASE_URL would "migrate" a throwaway PGlite and
  // deploy against an unmigrated database.
  if (process.env.VERCEL && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set for this Vercel build. Set it for this environment, then redeploy.");
  }
  const target = process.env.DATABASE_URL ? "DATABASE_URL" : `PGlite (${PGLITE_DATA_DIR})`;
  console.log(`Applying migrations to ${target}`);
  await migrate(getDb());
  console.log("Migrations applied");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
