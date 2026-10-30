import { z } from "zod";
import { buildSlots, MINUTES_PER_DAY } from "@/lib/time";

export const MAX_SLOT_COUNT = 20;

/** A whole number in range, with one plain message for a blank, fractional, too small, or too big value. */
function wholeNumber(min: number, max: number) {
  const message = `Enter a whole number from ${min} to ${max}.`;
  return z.int({ error: message }).min(min, message).max(max, message);
}

export const slotSchema = z
  .object({
    n: wholeNumber(1, MAX_SLOT_COUNT),
    startMinutes: z.int({ error: "Enter a start time." }).min(0, "Enter a start time.").max(MINUTES_PER_DAY - 1, "Enter a start time."),
    endMinutes: z.int({ error: "Enter an end time." }).min(1, "Enter an end time.").max(MINUTES_PER_DAY, "Enter an end time."),
  })
  .refine((slot) => slot.endMinutes > slot.startMinutes, {
    message: "A slot must end after it starts.",
    path: ["endMinutes"],
  });

export const biztechOptInRuleSchema = z.enum(["from_biztech_file", "all_opted_in"]);

export const eventSettingsSchema = z
  .object({
    slotCount: wholeNumber(1, MAX_SLOT_COUNT),
    slots: z.array(slotSchema).min(1, "Add at least one slot.").max(MAX_SLOT_COUNT, `Use at most ${MAX_SLOT_COUNT} slots.`),
    supplierTarget: wholeNumber(1, MAX_SLOT_COUNT),
    buyerMin: wholeNumber(0, MAX_SLOT_COUNT),
    buyerMax: wholeNumber(1, MAX_SLOT_COUNT),
    buyerIdeal: wholeNumber(0, MAX_SLOT_COUNT),
    mutualTopN: wholeNumber(1, 500),
    hotelRankCutoff: wholeNumber(1, 500),
    biztechOptInRule: biztechOptInRuleSchema,
    /**
     * D&A asked in writing to keep participant data (SOW 4). When not true, the
     * retention cron deletes it 90 days after the event. Missing means false.
     * Changed only through `setRetainData`, which works in every status.
     */
    retainData: z.boolean().optional(),
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
  retainData: false,
};
