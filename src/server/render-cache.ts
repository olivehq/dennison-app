import { cache } from "react";
import { getDb, type Db } from "@/db/client";

/**
 * Shares a read across one Server Component render (layouts, page, and the
 * sidebar slot) when it runs on the default client, whether the caller passed
 * that client or left the default. A transaction or any other handle always
 * reads fresh. Outside a render (Server Actions, route handlers, tests)
 * React's cache keeps nothing, so a write never sees an older read.
 */
export function cachePerRender<A extends unknown[], R>(
  read: (db: Db, ...args: A) => Promise<R>,
): (db: Db, ...args: A) => Promise<R> {
  const cached = cache((...args: A) => read(getDb(), ...args));
  return (db, ...args) => (db === getDb() ? cached(...args) : read(db, ...args));
}
