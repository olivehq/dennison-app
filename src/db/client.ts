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

export const PGLITE_DATA_DIR = ".data/pglite";

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

function getConnection(): Connection {
  if (connection) return connection;
  // In development the module re-evaluates on HMR; globalThis survives that.
  if (!env.isProduction && globalStore.__awDbConnection) {
    connection = globalStore.__awDbConnection;
    return connection;
  }
  connection = openConnection();
  if (!env.isProduction) globalStore.__awDbConnection = connection;
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
  if (!env.isProduction) delete globalStore.__awDbConnection;
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
