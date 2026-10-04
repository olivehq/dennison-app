/** The `note` of an `appointment.undo` audit row, which is how "already undone" is found (D32). */
export const UNDO_NOTE_PREFIX = "Undo of audit event ";

export function undoNote(auditEventId: string): string {
  return `${UNDO_NOTE_PREFIX}${auditEventId}`;
}
