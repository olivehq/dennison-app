import { describe, expect, it } from "vitest";
import type { ImportState } from "@/lib/schemas/import";
import { uploadCardState, type UploadCardFile } from "./upload-card-state";

const counts = { rows: 70, rankers: 12, rankings: 13, resolvedNames: 10, unknownNames: 3, errors: 2, warnings: 0 };
const file = (state: ImportState): UploadCardFile => ({ state, counts });

describe("uploadCardState", () => {
  it("asks for a file when none was uploaded", () => {
    expect(uploadCardState("participants", null, null)).toEqual({
      pill: "not_uploaded",
      count: null,
      action: { label: "Choose file", kind: "choose" },
    });
  });

  it("shows an ignored file when every file of the kind is ignored", () => {
    expect(uploadCardState("suppliers", null, file("ignored"))).toMatchObject({ pill: "ignored", action: { label: "Upload new file" } });
  });

  it("counts people, suppliers, or rankings once applied", () => {
    expect(uploadCardState("participants", file("applied"), null)).toMatchObject({ pill: "applied", count: "70 people" });
    expect(uploadCardState("suppliers", file("applied"), null)).toMatchObject({ count: "70 suppliers" });
    expect(uploadCardState("buyer_hotel_rankings", file("applied"), null)).toMatchObject({
      count: "13 rankings",
      action: { label: "Upload new file", kind: "choose" },
    });
  });

  it("sends files waiting on an admin to their report", () => {
    expect(uploadCardState("suppliers", file("ready"), null)).toMatchObject({ pill: "ready", action: { label: "Review and apply", kind: "review" } });
    expect(uploadCardState("supplier_rankings", file("needs_mapping"), null)).toMatchObject({
      count: "3 names",
      action: { label: "Fix names", kind: "review" },
    });
  });

  it("asks for a new file when this one can't be applied", () => {
    expect(uploadCardState("participants", file("needs_fixes"), null)).toMatchObject({
      count: "2 errors",
      action: { label: "Upload new file", kind: "choose" },
    });
    expect(uploadCardState("participants", { state: "failed", counts: null }, null)).toMatchObject({ pill: "failed", count: null });
  });
});
