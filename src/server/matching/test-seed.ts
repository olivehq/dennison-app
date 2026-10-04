import type { Db } from "@/db/client";
import {
  admins,
  events,
  participants,
  rankings,
  suppliers,
  type EventStatus,
  type NewRanking,
  type Participant,
  type Supplier,
} from "@/db/schema";
import { defaultEventSettings, type EventSettings } from "@/lib/schemas/event-settings";

/**
 * Test fixture shared by the matching, schedule, and tokens tests: one event
 * with 12 buyers, 6 suppliers (3 business, 3 hotel), and a full set of
 * rankings with a few blanks, one N/A, and one buyer opted out of biztech.
 */

export const TEST_ADMIN_ID = "admin-test";

export type Seeded = {
  eventId: string;
  adminId: string;
  buyers: Participant[];
  suppliers: Supplier[];
};

export const SUPPLIER_FIXTURES: { name: string; type: Supplier["type"]; attendee: boolean }[] = [
  { name: "Hyatt Regency Monterey", type: "hotel", attendee: true },
  { name: "Alpha Audio", type: "business", attendee: false },
  { name: "Carmel Valley Ranch", type: "hotel", attendee: true },
  { name: "Bravo Lighting", type: "business", attendee: false },
  { name: "Monterey Plaza Hotel", type: "hotel", attendee: true },
  { name: "Delta Staging", type: "business", attendee: false },
];

/** Settings that give 12 buyers a reachable range with 6 suppliers at 9 each. */
export const TEST_SETTINGS: EventSettings = {
  ...defaultEventSettings,
  supplierTarget: 9,
  buyerMin: 3,
  buyerMax: 6,
  buyerIdeal: 5,
  mutualTopN: 3,
  hotelRankCutoff: 5,
};

export async function ensureTestAdmin(db: Db): Promise<string> {
  await db
    .insert(admins)
    .values({ id: TEST_ADMIN_ID, name: "Test Admin", email: "admin@example.com" })
    .onConflictDoNothing();
  return TEST_ADMIN_ID;
}

export async function seedEvent(
  db: Db,
  options: { buyers?: number; status?: EventStatus; name?: string; settings?: Partial<EventSettings> } = {},
): Promise<Seeded> {
  const adminId = await ensureTestAdmin(db);
  const buyerCount = options.buyers ?? 12;
  const name = options.name ?? `AW ${Math.random().toString(36).slice(2, 8)}`;
  const [event] = await db
    .insert(events)
    .values({
      name,
      eventDate: "2026-11-10",
      timezone: "America/Los_Angeles",
      status: options.status ?? "imported",
      settings: { ...TEST_SETTINGS, ...options.settings },
    })
    .returning();

  const buyerRows = await db
    .insert(participants)
    .values(
      Array.from({ length: buyerCount }, (_, i) => ({
        eventId: event.id,
        email: `buyer${i}@example.com`,
        firstName: `Buyer${i}`,
        lastName: "Person",
        organization: i % 2 === 0 ? `Org ${i}` : null,
        title: i % 2 === 0 ? `Title ${i}` : null,
        // The last buyer is opted out of biztech (D1).
        biztechOptIn: i !== buyerCount - 1,
      })),
    )
    .returning();

  const supplierRows = await db
    .insert(suppliers)
    .values(
      SUPPLIER_FIXTURES.map((s, j) => ({
        eventId: event.id,
        name: s.name,
        type: s.type,
        adminContactName: `${s.name} admin`,
        adminContactEmail: `admin${j}@supplier.example.com`,
        attendeeContactName: s.attendee ? `${s.name} attendee` : null,
        attendeeContactEmail: s.attendee ? `attendee${j}@supplier.example.com` : null,
      })),
    )
    .returning();

  const rows: NewRanking[] = [];
  buyerRows.forEach((b, i) => {
    supplierRows.forEach((s, j) => {
      // Buyer 0 rejects the last supplier (an N/A, D2).
      if (i === 0 && j === supplierRows.length - 1) {
        rows.push({
          eventId: event.id,
          rankerType: "buyer",
          rankerId: b.id,
          targetType: "supplier",
          targetId: s.id,
          rank: null,
          isRejection: true,
        });
        return;
      }
      // A few blanks so the stats have something in section E.
      if ((i + j) % 7 === 0) return;
      rows.push({
        eventId: event.id,
        rankerType: "buyer",
        rankerId: b.id,
        targetType: "supplier",
        targetId: s.id,
        rank: ((i + j) % supplierRows.length) + 1,
        isRejection: false,
      });
    });
  });
  supplierRows.forEach((s, j) => {
    buyerRows.forEach((b, i) => {
      if ((i * 3 + j) % 11 === 0) return;
      rows.push({
        eventId: event.id,
        rankerType: "supplier",
        rankerId: s.id,
        targetType: "buyer",
        targetId: b.id,
        rank: ((i * 2 + j) % buyerRows.length) + 1,
        isRejection: false,
      });
    });
  });
  await db.insert(rankings).values(rows);

  return { eventId: event.id, adminId, buyers: buyerRows, suppliers: supplierRows };
}

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
