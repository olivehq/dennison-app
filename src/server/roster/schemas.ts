import { z } from "zod";
import { participantSchema, supplierSchema } from "@/lib/schemas/roster";

/** Form payloads for the roster actions: the template schema plus the event and an optional id for edits. */
export const saveParticipantSchema = participantSchema.extend({
  eventId: z.uuid(),
  id: z.uuid().optional(),
});

export const saveSupplierSchema = supplierSchema.extend({
  eventId: z.uuid(),
  id: z.uuid().optional(),
});

export type SaveParticipantInput = z.infer<typeof saveParticipantSchema>;
export type SaveSupplierInput = z.infer<typeof saveSupplierSchema>;
