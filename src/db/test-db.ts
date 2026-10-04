import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { setDbForTests, type Db } from "./client";
import { migrate } from "./migrate";
import * as schema from "./schema";

/**
 * A fresh in-memory Postgres with all migrations applied. Also becomes the
 * instance `getDb()` returns, so server modules under test use it.
 */
export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db);
  setDbForTests(db);
  return db;
}
