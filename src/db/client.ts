import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Schema = typeof schema;

/** Driver-agnostic database handle. Both PGlite and postgres.js instances satisfy it. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

/** The handle passed to a `db.transaction(async (tx) => ...)` callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const PGLITE_DATA_DIR = `${env.LOCAL_DATA_DIR}/pglite`;

type Connection =
  | { kind: "pglite"; db: PgliteDatabase<Schema>; client: PGlite }
  | { kind: "postgres"; db: PostgresJsDatabase<Schema>; client: postgres.Sql };

const globalStore = globalThis as unknown as { __awDbConnection?: Connection };

let connection: Connection | undefined;
let injectedDb: Db | undefined;

function openConnection(): Connection {
  if (env.DATABASE_URL) {
    // One connection per serverless instance. `prepare: false` keeps the Neon
    // pooler (transaction mode) happy.
    const client = postgres(env.DATABASE_URL, { max: 1, prepare: false });
    return { kind: "postgres", client, db: drizzlePostgres({ client, schema }) };
  }
  // PGlite does not create parent directories itself.
  mkdirSync(PGLITE_DATA_DIR, { recursive: true });
  const client = new PGlite(PGLITE_DATA_DIR);
  return { kind: "pglite", client, db: drizzlePglite({ client, schema }) };
}

/**
 * Share one connection per process through globalThis when: in development
 * (modules re-evaluate on HMR), and for PGlite always, because `next start`
 * loads this module once per server bundle and PGlite allows one instance per
 * folder (a second instance does not see the first one's writes).
 */
function shareConnection(): boolean {
  return !env.isProduction || !env.DATABASE_URL;
}

function getConnection(): Connection {
  if (connection) return connection;
  if (shareConnection() && globalStore.__awDbConnection) {
    connection = globalStore.__awDbConnection;
    return connection;
  }
  connection = openConnection();
  if (shareConnection()) globalStore.__awDbConnection = connection;
  return connection;
}

export function getDb(): Db {
  if (injectedDb) return injectedDb;
  return getConnection().db;
}

/** Tests inject a PGlite instance so server code under test never touches .data or Postgres. */
export function setDbForTests(db: Db | undefined): void {
  injectedDb = db;
}

/** Closes the live connection so one-off scripts can exit. */
export async function closeDb(): Promise<void> {
  const current = connection;
  connection = undefined;
  if (shareConnection()) delete globalStore.__awDbConnection;
  if (!current) return;
  if (current.kind === "postgres") {
    await current.client.end();
  } else {
    await current.client.close();
  }
}

export function isPgliteDb(db: Db): db is PgliteDatabase<Schema> {
  return "$client" in db && db.$client instanceof PGlite;
}
