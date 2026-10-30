import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { isPooledUrl, releaseEvents } from "./client";

describe("isPooledUrl", () => {
  it("is true only for Neon's pooled hostname", () => {
    expect(isPooledUrl("postgresql://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/db?sslmode=require")).toBe(true);
    expect(isPooledUrl("postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/db?sslmode=require")).toBe(false);
    expect(isPooledUrl("postgres://aw:aw@localhost:5432/aw")).toBe(false);
    // Only the hostname counts, not the user or database name.
    expect(isPooledUrl("postgres://my-pooler:p@localhost:5432/x-pooler")).toBe(false);
    expect(isPooledUrl("not a url")).toBe(false);
  });
});

describe("releaseEvents", () => {
  function fakeClient() {
    let settle: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | undefined;
    const pending = () => new Promise((resolve, reject) => (settle = { resolve, reject }));
    const client = { unsafe: vi.fn(pending), begin: vi.fn(pending) } as unknown as postgres.Sql;
    return { client, settle: () => settle! };
  }

  it("reports the pg pool shape attachDatabasePool expects", () => {
    const pool = releaseEvents(fakeClient().client, 20_000);
    expect(pool.options).toEqual({ idleTimeoutMillis: 20_000 });
    expect(typeof pool.on).toBe("function");
  });

  it("emits release when a query or transaction settles, failed ones included, and returns the original promise", async () => {
    const { client, settle } = fakeClient();
    const pool = releaseEvents(client, 20_000);
    const listener = vi.fn();
    pool.on("release", listener);

    const query = client.unsafe("select 1");
    expect(listener).not.toHaveBeenCalled();
    settle().resolve([]);
    await expect(query).resolves.toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);

    const tx = client.begin(async () => "done");
    settle().reject(new Error("boom"));
    await expect(tx).rejects.toThrow("boom");
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
