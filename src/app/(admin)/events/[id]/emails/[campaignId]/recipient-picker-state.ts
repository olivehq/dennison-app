/**
 * The recipient picker's working selection. It starts from the campaign's
 * saved choice every time the dialog opens, so Cancel (or Escape) discards
 * whatever was ticked; only "Use" hands the selection back.
 */

export type PickerState = { open: boolean; picked: ReadonlySet<string> };

export type PickerAction =
  | { type: "sync"; open: boolean; value: readonly string[] }
  | { type: "toggle"; key: string; checked: boolean }
  | { type: "replace"; keys: Iterable<string> };

export function pickerReducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "sync":
      if (action.open === state.open) return state;
      return { open: action.open, picked: action.open ? new Set(action.value) : state.picked };
    case "toggle": {
      const picked = new Set(state.picked);
      if (action.checked) picked.add(action.key);
      else picked.delete(action.key);
      return { ...state, picked };
    }
    case "replace":
      return { ...state, picked: new Set(action.keys) };
  }
}

/** What "Use" hands back: the picked contacts' keys in list order. */
export function pickedKeys(contacts: readonly { key: string }[], picked: ReadonlySet<string>): string[] {
  return contacts.filter((c) => picked.has(c.key)).map((c) => c.key);
}
