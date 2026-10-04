import { z } from "zod";

const supportedTimezones = new Set(Intl.supportedValuesOf("timeZone"));

export const timezoneSchema = z
  .string()
  .refine((value) => supportedTimezones.has(value), {
    message: "Pick a valid IANA timezone, for example America/Los_Angeles.",
  });

export const eventStatusSchema = z.enum([
  "draft",
  "imported",
  "matched",
  "locked",
  "sent",
  "archived",
]);

export const eventSchema = z.object({
  name: z.string().trim().min(1, "Give the event a name.").max(120),
  eventDate: z.iso.date("Use the format YYYY-MM-DD."),
  timezone: timezoneSchema,
});

export type EventStatus = z.infer<typeof eventStatusSchema>;
export type EventInput = z.infer<typeof eventSchema>;
