import type { Db } from "@/db/client";

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
