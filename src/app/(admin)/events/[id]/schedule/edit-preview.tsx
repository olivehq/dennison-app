"use client";

import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { EditPreview } from "./schedule-model";

/** One sentence for a confirm dialog: the changes, then each count that moves. */
export function previewSentence(preview: EditPreview): string {
  const counts = preview.counts.map((c) => `${c.name} goes from ${c.before} to ${c.after}`).join(", ");
  return `${preview.lines.join(". ")}.${counts ? ` ${counts}.` : ""}`;
}

/**
 * The step between picking a buyer and saving (scope 2.5): what the edit
 * removes and adds, and the meeting counts before and after.
 */
export function EditPreviewPanel({
  preview,
  pending,
  onSave,
  onCancel,
}: {
  preview: EditPreview;
  pending: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold">This change will</h3>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {preview.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      {preview.counts.length ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold">Meeting counts</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {preview.counts.map((c) => (
              <li key={c.personId} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{c.name}</span>
                <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
                  <span className="sr-only">from</span>
                  {c.before}
                  <ArrowRightIcon aria-hidden="true" className="size-3" />
                  <span className="sr-only">to</span>
                  <span className="font-semibold">{c.after}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={pending} onClick={onSave}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}
