"use client";

import { DownloadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";

/**
 * The access list rotates every participant link (D31), so it is a POST
 * behind a confirm. The file is fetched and saved here rather than by a form
 * navigation so a refusal shows as a toast and the page refreshes its
 * "Generated" line once the file has arrived.
 */
export function AccessListButton({
  href,
  filename,
  label,
  disabled,
}: {
  href: string;
  filename: string;
  label: string;
  disabled: boolean;
}) {
  const router = useRouter();

  const download = async () => {
    const response = await fetch(href, { method: "POST" });
    if (!response.ok) {
      toast.error((await response.text()) || "The access list could not be generated. Try again.");
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    // Revoking in the same tick can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success("Access list downloaded. Links sent before now no longer work.");
    router.refresh();
  };

  if (disabled) {
    return (
      <Button variant="outline" disabled>
        <DownloadIcon data-icon="inline-start" />
        {label}
      </Button>
    );
  }

  return (
    <ConfirmDialog
      title="Replace every participant link?"
      description="The access list needs fresh links, so every link already emailed or shared stops working. Only the links in this file will open schedules. Send them out again after downloading."
      confirmLabel="Replace links and download"
      destructive
      onConfirm={download}
      trigger={
        <Button variant="outline">
          <DownloadIcon data-icon="inline-start" />
          {label}
        </Button>
      }
    />
  );
}
