import { fileURLToPath } from "node:url";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isPgliteDb, type Db, type Schema } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** Applies every pending migration in src/db/migrations using the migrator for the active driver. */
export async function migrate(db: Db): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (isPgliteDb(db)) {
    await migratePglite(db, config);
    return;
  }
  await migratePostgres(db as PostgresJsDatabase<Schema>, config);
}
