import { closeDb, getDb, PGLITE_DATA_DIR } from "@/db/client";
import { migrate } from "@/db/migrate";

async function main() {
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
