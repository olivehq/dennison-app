import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * fixtures/aw-2025-results.js: the real 2025 schedule, written as
 * `window.AW_DATA = {...};` for the design mockups. Read as text and
 * JSON-parsed; never evaluated.
 */

const rank = z.int().min(1).nullable();

export const fixtureSchema = z.object({
  event: z.object({ name: z.string().min(1), date: z.iso.date() }),
  suppliers: z.array(z.object({ name: z.string().min(1), type: z.enum(["business", "hotel"]), desk: z.int().nullable() })),
  buyers: z.array(z.object({ name: z.string().min(1), organization: z.string().optional(), title: z.string().optional() })),
  appointments: z.array(
    z.object({ slot: z.int().min(1), supplier: z.string(), buyer: z.string(), buyerRank: rank, supplierRank: rank }),
  ),
});

export type Fixture = z.infer<typeof fixtureSchema>;

export const FIXTURE_PATH = resolve(process.cwd(), "fixtures/aw-2025-results.js");

export function parseFixture(source: string): Fixture {
  const assignment = /window\.AW_DATA\s*=\s*/.exec(source);
  if (!assignment) throw new Error("Expected `window.AW_DATA = {...}` in the fixture.");
  const start = assignment.index + assignment[0].length;
  const end = source.lastIndexOf("}");
  if (source[start] !== "{" || end < start) throw new Error("The fixture's AW_DATA is not an object literal.");
  const data: unknown = JSON.parse(source.slice(start, end + 1));
  const fixture = fixtureSchema.parse(data);

  const buyers = new Set(fixture.buyers.map((b) => b.name));
  const suppliers = new Set(fixture.suppliers.map((s) => s.name));
  for (const a of fixture.appointments) {
    if (!buyers.has(a.buyer)) throw new Error(`Appointment names an unknown buyer: ${a.buyer}`);
    if (!suppliers.has(a.supplier)) throw new Error(`Appointment names an unknown supplier: ${a.supplier}`);
  }
  return fixture;
}

export function loadFixture(path: string = FIXTURE_PATH): Fixture {
  return parseFixture(readFileSync(path, "utf8"));
}
