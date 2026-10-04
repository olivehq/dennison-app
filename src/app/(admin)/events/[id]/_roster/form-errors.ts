import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { toast } from "sonner";
import type { ActionError } from "@/lib/errors";

/**
 * Puts server field errors (validation, conflict) on the matching form fields
 * and toasts the summary. Keys the form doesn't know are only in the toast.
 */
export function applyActionError<T extends FieldValues>(
  error: ActionError,
  setError: UseFormSetError<T>,
  fields: readonly string[],
): void {
  for (const [key, messages] of Object.entries(error.fieldErrors ?? {})) {
    if (fields.includes(key)) setError(key as Path<T>, { type: "server", message: messages[0] });
  }
  toast.error(error.message);
}
