import { rmSync } from "node:fs";
import { E2E_DATA_DIR } from "../playwright.config";

export default function globalTeardown() {
  rmSync(E2E_DATA_DIR, { recursive: true, force: true });
}
