"use client";

import * as React from "react";
import { DownloadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * The access list reuses each contact's current link and issues one only for
 * contacts without (D31, D59), so it is a POST. The file is fetched and saved
 * here rather than by a form navigation so a refusal shows as a toast and the
 * page refreshes its "Generated" line once the file has arrived.
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
  const [pending, setPending] = React.useState(false);

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
    toast.success("Access list downloaded. Links already sent keep working.");
    router.refresh();
  };

  const run = async () => {
    setPending(true);
    try {
      await download();
    } finally {
      setPending(false);
    }
  };

  return (
    <Button variant="outline" disabled={disabled || pending} onClick={() => void run()}>
      {pending ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
      {label}
    </Button>
  );
}
