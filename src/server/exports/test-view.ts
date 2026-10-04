import type { ExportView } from "./common";

/**
 * A three-slot schedule for the builder tests: two buyers, two suppliers, one
 * of them without a desk yet, one blank buyer rank, and an open slot each.
 */
export const smallView: ExportView = {
  slots: [
    { slot: 1, start: "3:10 PM", end: "3:20 PM" },
    { slot: 2, start: "3:21 PM", end: "3:31 PM" },
    { slot: 3, start: "3:32 PM", end: "3:42 PM" },
  ],
  buyers: [
    { id: "b-zed", name: "Zed Org - Planner", withdrawn: false },
    { id: "b-acme", name: "Acme, Inc - Director", withdrawn: false },
    { id: "b-gone", name: "Gone Org - Planner", withdrawn: true },
  ],
  suppliers: [
    { id: "s-hotel", name: "Hilton Irvine/Orange County Airport", desk: 12, withdrawn: false },
    { id: "s-biz", name: "eShow", desk: null, withdrawn: false },
  ],
  appointments: [
    { slot: 2, buyerId: "b-zed", supplierId: "s-hotel", buyerRank: 3, supplierRank: 14 },
    { slot: 1, buyerId: "b-zed", supplierId: "s-biz", buyerRank: null, supplierRank: 2 },
    { slot: 1, buyerId: "b-acme", supplierId: "s-hotel", buyerRank: 1, supplierRank: 1 },
    { slot: 3, buyerId: "b-acme", supplierId: "s-biz", buyerRank: 7, supplierRank: null },
  ],
};
