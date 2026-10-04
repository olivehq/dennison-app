import { z } from "zod";
import { buildSlots, MINUTES_PER_DAY } from "@/lib/time";

export const MAX_SLOT_COUNT = 20;

export const slotSchema = z
  .object({
    n: z.int().min(1).max(MAX_SLOT_COUNT),
    startMinutes: z.int().min(0).max(MINUTES_PER_DAY - 1),
    endMinutes: z.int().min(1).max(MINUTES_PER_DAY),
  })
  .refine((slot) => slot.endMinutes > slot.startMinutes, {
    message: "A slot must end after it starts.",
    path: ["endMinutes"],
  });

export const biztechOptInRuleSchema = z.enum(["from_biztech_file", "all_opted_in"]);

export const eventSettingsSchema = z
  .object({
    slotCount: z.int().min(1).max(MAX_SLOT_COUNT),
    slots: z.array(slotSchema).min(1).max(MAX_SLOT_COUNT),
    supplierTarget: z.int().min(1).max(MAX_SLOT_COUNT),
    buyerMin: z.int().min(0).max(MAX_SLOT_COUNT),
    buyerMax: z.int().min(1).max(MAX_SLOT_COUNT),
    buyerIdeal: z.int().min(0).max(MAX_SLOT_COUNT),
    mutualTopN: z.int().min(1).max(500),
    hotelRankCutoff: z.int().min(1).max(500),
    biztechOptInRule: biztechOptInRuleSchema,
  })
  .superRefine((settings, ctx) => {
    if (settings.slots.length !== settings.slotCount) {
      ctx.addIssue({
        code: "custom",
        path: ["slots"],
        message: `Expected ${settings.slotCount} slots, got ${settings.slots.length}.`,
      });
    }
    settings.slots.forEach((slot, index) => {
      if (slot.n !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["slots", index, "n"],
          message: `Slot ${index + 1} is numbered ${slot.n}.`,
        });
      }
      const previous = settings.slots[index - 1];
      if (previous && slot.startMinutes < previous.endMinutes) {
        ctx.addIssue({
          code: "custom",
          path: ["slots", index, "startMinutes"],
          message: `Slot ${slot.n} overlaps slot ${previous.n}.`,
        });
      }
    });
    if (settings.supplierTarget > settings.slotCount) {
      ctx.addIssue({
        code: "custom",
        path: ["supplierTarget"],
        message: "Supplier target cannot exceed the number of slots.",
      });
    }
    if (settings.buyerMax > settings.slotCount) {
      ctx.addIssue({
        code: "custom",
        path: ["buyerMax"],
        message: "Buyer maximum cannot exceed the number of slots.",
      });
    }
    if (settings.buyerMin > settings.buyerMax) {
      ctx.addIssue({
        code: "custom",
        path: ["buyerMin"],
        message: "Buyer minimum cannot exceed the buyer maximum.",
      });
    }
    if (settings.buyerIdeal < settings.buyerMin || settings.buyerIdeal > settings.buyerMax) {
      ctx.addIssue({
        code: "custom",
        path: ["buyerIdeal"],
        message: "Buyer ideal must sit between the minimum and maximum.",
      });
    }
  });

export type Slot = z.infer<typeof slotSchema>;
export type BiztechOptInRule = z.infer<typeof biztechOptInRuleSchema>;
export type EventSettings = z.infer<typeof eventSettingsSchema>;

/** The 2025 show: nine 10-minute slots, 11 minutes apart, 3:10 PM to 4:48 PM. */
export const defaultEventSettings: EventSettings = {
  slotCount: 9,
  slots: buildSlots({ count: 9, firstStartMinutes: 15 * 60 + 10, durationMinutes: 10, gapMinutes: 1 }),
  supplierTarget: 9,
  buyerMin: 7,
  buyerMax: 9,
  buyerIdeal: 8,
  mutualTopN: 10,
  hotelRankCutoff: 27,
  biztechOptInRule: "from_biztech_file",
};
