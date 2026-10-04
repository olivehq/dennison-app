import type { Db } from "@/db/client";

/**
 * Test helper for compare-and-set checks: a `Db` that runs `between` once,
 * just before the first transaction opens. Simulates another admin's change
 * landing after a function read the event but before it wrote.
 */
export function raceBeforeTransaction(db: Db, between: () => Promise<unknown>): Db {
  let fired = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (...args: Parameters<Db["transaction"]>) => {
          if (!fired) {
            fired = true;
            await between();
          }
          return target.transaction(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
