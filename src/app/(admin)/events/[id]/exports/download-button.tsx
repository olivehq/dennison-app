"use client";

import * as React from "react";
import { DownloadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** The file name in a `Content-Disposition: attachment; filename="..."` header, or null. */
function filenameFrom(header: string | null): string | null {
  const match = header?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

/**
 * A GET export. The file is fetched and saved here rather than by a plain link so a refusal
 * (no schedule, no statistics, a failed build) shows as a toast instead of a bare text file
 * in the browser, and the page refreshes its "Generated" line once the file has arrived.
 * The whole file is held in memory before it is saved, with no browser progress bar; fine
 * for this event's files (the schedules ZIP is a few MB), worth revisiting for much larger ones.
 */
export function DownloadButton({
  href,
  filename,
  label,
}: {
  href: string;
  /** Used when the response names no file. */
  filename: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const download = async () => {
    const response = await fetch(href);
    if (!response.ok) {
      toast.error((await response.text()) || "The file could not be generated. Try again.");
      return;
    }
    const name = filenameFrom(response.headers.get("Content-Disposition")) ?? filename;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    // Revoking in the same tick can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(`${name} downloaded.`);
    router.refresh();
  };

  const run = async () => {
    setPending(true);
    try {
      await download();
    } catch {
      toast.error("The file could not be downloaded. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Button variant="outline" disabled={pending} onClick={() => void run()}>
      {pending ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
      {label}
    </Button>
  );
}
