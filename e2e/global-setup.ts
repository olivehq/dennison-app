import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { E2E_DATA_DIR, E2E_URL } from "../playwright.config";
import { E2E_ADMIN } from "./helpers";

/** A fresh database: migrate, the first admin, the demo event. Each step is its own process, which releases PGlite on exit. */
export default function globalSetup() {
  rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  const env = { ...process.env, LOCAL_DATA_DIR: E2E_DATA_DIR, APP_URL: E2E_URL, DATABASE_URL: "" };
  const run = (...args: string[]) => execFileSync("pnpm", args, { env, stdio: "inherit" });
  run("db:migrate");
  run("create-admin", E2E_ADMIN.email, E2E_ADMIN.name, E2E_ADMIN.password);
  run("db:seed");
}
