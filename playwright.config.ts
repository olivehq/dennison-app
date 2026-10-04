import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests: `pnpm e2e`. A dev server on port 3400 runs against its own
 * PGlite folder (LOCAL_DATA_DIR, D75), migrated, given an admin, and seeded
 * by e2e/global-setup.ts. The specs run in order on one worker because the
 * last one locks the demo event.
 */
export const E2E_PORT = 3400;
export const E2E_DATA_DIR = ".data-e2e";
export const E2E_URL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: E2E_URL,
    trace: "retain-on-failure",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next dev -p ${E2E_PORT}`,
    // Playwright starts the server before globalSetup. The favicon never
    // touches the database, so the seed can still take the PGlite folder.
    url: `${E2E_URL}/favicon.ico`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { LOCAL_DATA_DIR: E2E_DATA_DIR, APP_URL: E2E_URL, NEXT_TELEMETRY_DISABLED: "1" },
  },
});
