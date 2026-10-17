import { toast } from "sonner";
import { ignoreImportAction, stopIgnoringImportAction } from "@/server/imports/actions";

/**
 * "Ignore file" and "Stop ignoring", shared by the import page and the
 * history row menu. Toasts the outcome; true when it worked.
 */
export async function setImportIgnored(importId: string, fileName: string, ignore: boolean): Promise<boolean> {
  const result = ignore ? await ignoreImportAction(importId) : await stopIgnoringImportAction(importId);
  if (!result.ok) {
    toast.error(result.error.message);
    return false;
  }
  toast.success(
    ignore
      ? `${fileName} is ignored. It no longer blocks matching.`
      : `${fileName} is no longer ignored and was checked again.`,
  );
  return true;
}
