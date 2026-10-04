import { beforeAll, describe, expect, it } from "vitest";
import { getFile, importFileKey, putFile, useMemoryStorageForTests } from "./storage";

beforeAll(() => {
  useMemoryStorageForTests();
});

describe("storage (memory adapter)", () => {
  it("stores and reads a file back with its content type", async () => {
    const key = importFileKey("event-1", "import-1", "Buyers 2026.xlsx");
    expect(key).toBe("events/event-1/imports/import-1/Buyers_2026.xlsx");

    await putFile({ key, body: Buffer.from("hello"), contentType: "text/plain" });
    const stored = await getFile(key);
    expect(stored?.body.toString()).toBe("hello");
    expect(stored?.contentType).toBe("text/plain");
  });

  it("returns null for unknown keys", async () => {
    expect(await getFile("events/x/imports/y/missing.csv")).toBeNull();
  });

  it("rejects keys that escape the prefix", async () => {
    await expect(getFile("../etc/passwd")).rejects.toThrow(/Unsafe storage key/);
    await expect(
      putFile({ key: "/abs", body: Buffer.from(""), contentType: "text/plain" }),
    ).rejects.toThrow(/Unsafe storage key/);
  });
});
