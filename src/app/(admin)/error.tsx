"use client";

import { TriangleAlertIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function AdminError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  const tryAgain = retry ?? reset;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 py-12">
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>This page hit an error</AlertTitle>
        <AlertDescription>
          Nothing was saved. Try again, and if it keeps failing tell Olive and quote this code:{" "}
          <span className="font-medium">{error.digest ?? "no code"}</span>.
        </AlertDescription>
      </Alert>
      {tryAgain ? (
        <Button variant="outline" className="self-start" onClick={() => tryAgain()}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
