import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address."));

export const rosterStatusSchema = z.enum(["active", "withdrawn"]);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

export const participantSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().min(1, "First name is required.").max(80),
  lastName: z.string().trim().min(1, "Last name is required.").max(80),
  organization: optionalText(160),
  title: optionalText(160),
  displayName: optionalText(200),
  biztechOptIn: z.boolean().default(false),
});

export const supplierTypeSchema = z.enum(["business", "hotel"]);

export const supplierContactSchema = z.object({
  name: z.string().trim().min(1, "Contact name is required.").max(160),
  email: emailSchema,
});

export const supplierSchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required.").max(160),
  type: supplierTypeSchema,
  deskNumber: z.int().min(1).max(999).nullable().optional(),
  deskOverride: z.boolean().default(false),
  adminContact: supplierContactSchema.nullable().optional(),
  attendeeContact: supplierContactSchema.nullable().optional(),
});

export type RosterStatus = z.infer<typeof rosterStatusSchema>;
export type ParticipantInput = z.infer<typeof participantSchema>;
export type SupplierType = z.infer<typeof supplierTypeSchema>;
export type SupplierContact = z.infer<typeof supplierContactSchema>;
export type SupplierInput = z.infer<typeof supplierSchema>;
