"use client";

import * as React from "react";
import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { recheckImportAction } from "@/server/imports/actions";

/** Shown when the roster changed after the report was made. Applying checks again anyway; this keeps the page honest. */
export function StaleReportAlert({ importId, lockedReason }: { importId: string; lockedReason: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const recheck = () =>
    startTransition(async () => {
      const result = await recheckImportAction(importId);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success("Checked the file again.");
      router.refresh();
    });

  return (
    <Alert>
      <RefreshCwIcon />
      <AlertTitle>This report may be out of date</AlertTitle>
      <AlertDescription>
        <p>Checking this file now gives a different result, usually because the roster or saved names changed. Check it again.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 w-fit"
          onClick={recheck}
          disabled={pending || lockedReason !== null}
          title={lockedReason ?? undefined}
        >
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Check again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
