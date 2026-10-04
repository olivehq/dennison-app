import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get as blobGet, put as blobPut } from "@vercel/blob";
import { env } from "@/lib/env";

export type StoredFile = {
  body: Buffer;
  contentType: string;
};

type StorageAdapter = {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
};

export const LOCAL_UPLOADS_DIR = ".data/uploads";

/** `events/<eventId>/imports/<importId>/<filename>` */
export function importFileKey(eventId: string, importId: string, filename: string): string {
  return `events/${eventId}/imports/${importId}/${sanitizeFilename(filename)}`;
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^A-Za-z0-9._-]+/g, "_");
  return base.length ? base : "file";
}

function assertSafeKey(key: string): void {
  const segments = key.split("/");
  if (
    !key ||
    key.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

function blobAdapter(token: string): StorageAdapter {
  return {
    async put(key, body, contentType) {
      await blobPut(key, body, {
        access: "private",
        token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    },
    async get(key) {
      const result = await blobGet(key, { access: "private", token });
      if (!result) return null;
      const body = Buffer.from(await new Response(result.stream).arrayBuffer());
      return { body, contentType: result.blob.contentType ?? "application/octet-stream" };
    },
  };
}

function localAdapter(root: string): StorageAdapter {
  const filePath = (key: string) => path.join(root, key);
  const metaPath = (key: string) => `${filePath(key)}.meta.json`;
  return {
    async put(key, body, contentType) {
      await mkdir(path.dirname(filePath(key)), { recursive: true });
      await writeFile(filePath(key), body);
      await writeFile(metaPath(key), JSON.stringify({ contentType }));
    },
    async get(key) {
      try {
        const [body, meta] = await Promise.all([
          readFile(filePath(key)),
          readFile(metaPath(key), "utf8"),
        ]);
        const { contentType } = JSON.parse(meta) as { contentType: string };
        return { body, contentType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

function memoryAdapter(): StorageAdapter {
  const files = new Map<string, StoredFile>();
  return {
    async put(key, body, contentType) {
      files.set(key, { body: Buffer.from(body), contentType });
    },
    async get(key) {
      return files.get(key) ?? null;
    },
  };
}

let adapter: StorageAdapter | undefined;

function getAdapter(): StorageAdapter {
  if (adapter) return adapter;
  adapter = env.BLOB_READ_WRITE_TOKEN
    ? blobAdapter(env.BLOB_READ_WRITE_TOKEN)
    : localAdapter(LOCAL_UPLOADS_DIR);
  return adapter;
}

/** Swap in an in-memory store. Call once at the top of a test file. */
export function useMemoryStorageForTests(): void {
  adapter = memoryAdapter();
}

export async function putFile(input: {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}): Promise<{ key: string }> {
  assertSafeKey(input.key);
  await getAdapter().put(input.key, Buffer.from(input.body), input.contentType);
  return { key: input.key };
}

export async function getFile(key: string): Promise<StoredFile | null> {
  assertSafeKey(key);
  return getAdapter().get(key);
}
