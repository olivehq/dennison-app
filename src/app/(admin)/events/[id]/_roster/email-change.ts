import type { ScheduleChangeState } from "@/server/email/schedule-hash";
import type { EmailChange } from "./types";

/** One contact's "changed since last email" state from the email module (D13). */
export function emailChangeOf(state: ScheduleChangeState, key: string): EmailChange {
  if (state.changed.has(key)) return "changed";
  return state.emailed.has(key) ? "current" : null;
}
