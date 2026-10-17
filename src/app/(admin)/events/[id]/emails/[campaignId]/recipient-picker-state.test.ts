import { describe, expect, it } from "vitest";
import { pickedKeys, pickerReducer, type PickerState } from "./recipient-picker-state";

const contacts = [{ key: "buyer:a" }, { key: "buyer:b" }, { key: "buyer:c" }];

describe("pickerReducer", () => {
  it("discards ticks on Cancel: reopening starts from the saved value, and Use returns it unchanged", () => {
    const saved = ["buyer:a"];
    let state: PickerState = { open: false, picked: new Set(saved) };
    // The parent opens the dialog by setting `open`; the picker syncs on render.
    state = pickerReducer(state, { type: "sync", open: true, value: saved });
    state = pickerReducer(state, { type: "toggle", key: "buyer:b", checked: true });
    state = pickerReducer(state, { type: "toggle", key: "buyer:a", checked: false });
    expect(pickedKeys(contacts, state.picked)).toEqual(["buyer:b"]);

    // Cancel closes without calling onChange, so the saved value is still ["buyer:a"].
    state = pickerReducer(state, { type: "sync", open: false, value: saved });
    state = pickerReducer(state, { type: "sync", open: true, value: saved });
    expect(pickedKeys(contacts, state.picked)).toEqual(saved);
  });

  it("keeps the selection while open, even when the parent re-renders with the same value", () => {
    let state: PickerState = pickerReducer({ open: false, picked: new Set() }, { type: "sync", open: true, value: [] });
    state = pickerReducer(state, { type: "replace", keys: ["buyer:c", "buyer:a"] });
    const same = pickerReducer(state, { type: "sync", open: true, value: [] });
    expect(same).toBe(state);
    expect(pickedKeys(contacts, same.picked)).toEqual(["buyer:a", "buyer:c"]);
  });
});
