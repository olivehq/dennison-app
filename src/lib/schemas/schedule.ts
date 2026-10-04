import { z } from "zod";
import { MAX_SLOT_COUNT } from "./event-settings";

/**
 * Inputs for the schedule editor and matching actions. Every edit carries the
 * run id and the version the client read (D11); a stale version is refused.
 *
 * Follow-up: re-export from `src/lib/schemas/index.ts` once that file is free.
 */

const uuid = z.uuid("Expected an id.");
const slot = z.int().min(1).max(MAX_SLOT_COUNT);
const version = z.int().min(1);
const note = z.string().trim().max(500).optional();

export const replaceAppointmentInput = z.object({
  runId: uuid,
  version,
  slot,
  supplierId: uuid,
  removeBuyerId: uuid,
  addBuyerId: uuid,
  note,
});

export const addAppointmentInput = z.object({
  runId: uuid,
  version,
  slot,
  supplierId: uuid,
  buyerId: uuid,
  note,
});

export const removeAppointmentInput = z.object({
  runId: uuid,
  version,
  slot,
  supplierId: uuid,
  buyerId: uuid,
  note,
});

export const swapCandidatesInput = z.object({
  runId: uuid,
  supplierId: uuid,
  slot,
  excludeBuyerId: uuid.optional(),
});

export const undoAuditInput = z.object({ auditEventId: uuid });

export const setPinnedInput = z.object({ appointmentId: uuid, pinned: z.boolean() });

export const runMatchingInput = z.object({ keepExisting: z.boolean().default(false) });

export const lockScheduleInput = z.object({ eventId: uuid });

export const unlockScheduleInput = z.object({
  eventId: uuid,
  reason: z.string().trim().min(1, "Say why you are unlocking.").max(500),
});

export type ReplaceAppointmentInput = z.infer<typeof replaceAppointmentInput>;
export type AddAppointmentInput = z.infer<typeof addAppointmentInput>;
export type RemoveAppointmentInput = z.infer<typeof removeAppointmentInput>;
export type SwapCandidatesInput = z.infer<typeof swapCandidatesInput>;
export type UndoAuditInput = z.infer<typeof undoAuditInput>;
export type SetPinnedInput = z.infer<typeof setPinnedInput>;
export type RunMatchingInput = z.infer<typeof runMatchingInput>;
export type LockScheduleInput = z.infer<typeof lockScheduleInput>;
export type UnlockScheduleInput = z.infer<typeof unlockScheduleInput>;
