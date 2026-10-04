import { z } from "zod";
import { MAX_SLOT_COUNT } from "./event-settings";

/**
 * Inputs for the schedule editor and matching actions. Every edit carries the
 * run id and the version the client read (D11); a stale version is refused.
 *
 * Follow-up: re-export from `src/lib/schemas/index.ts` once that file is free.
 */

/** Returned with code `conflict` when a save carries a stale run version (D11). Shared so the client can tell it apart. */
export const VERSION_CONFLICT_MESSAGE =
  "Someone else changed this schedule. Review their change, then try again.";

/** Returned with code `conflict` when an edit targets a run that is no longer the active one (D33). */
export const NOT_ACTIVE_RUN_MESSAGE = "This schedule is no longer the active one. Reload to see the current schedule.";

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

/** `version` is optional for one release so callers that do not send it yet keep working (D11). */
export const undoAuditInput = z.object({ auditEventId: uuid, version: version.optional() });

export const setPinnedInput = z.object({ appointmentId: uuid, pinned: z.boolean(), version: version.optional() });

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
