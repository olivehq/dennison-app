import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";

/**
 * Test helper for compare-and-set checks: a `Db` that runs `between` once,
 * just before a transaction opens (the first, or the `nth` when given).
 * Simulates another admin's change landing after a function read the event
 * but before it wrote.
 */
export function raceBeforeTransaction(db: Db, between: () => Promise<unknown>, nth = 1): Db {
  let opened = 0;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (...args: Parameters<Db["transaction"]>) => {
          opened += 1;
          if (opened === nth) await between();
          return target.transaction(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * Test helper for lock order: a second handle on the same PGlite database that
 * records every SQL statement it runs, in order, so a test can check which row
 * a transaction locks first. Only for databases made by `createTestDb`.
 */
export function recordQueries(db: Db): { db: Db; queries: string[] } {
  const queries: string[] = [];
  const client = (db as unknown as { $client: PGlite }).$client;
  const recorded = drizzle({ client, schema, logger: { logQuery: (query) => void queries.push(query) } });
  return { db: recorded as unknown as Db, queries };
}
