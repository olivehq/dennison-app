"use client";

import * as React from "react";
import { DownloadIcon, UploadIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileDropzone } from "@/components/app/file-dropzone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { IMPORT_FILE_EXTENSIONS, IMPORT_MAX_FILE_BYTES, type ImportKind, type ImportState } from "@/lib/schemas/import";
import { uploadImport } from "@/server/imports/actions";
import { ImportStateBadge, importHref, KIND_DESCRIPTIONS, KIND_LABELS, templateHref } from "./import-labels";

export type LatestImport = {
  id: string;
  fileName: string;
  state: ImportState;
  /** Counts already worded, for example ["42 rows", "3 unknown names"]. */
  facts: string[];
  uploadedLabel: string;
};

const ACCEPT = [...IMPORT_FILE_EXTENSIONS];

const UPLOADED_MESSAGES: Record<ImportState, string> = {
  failed: "couldn't be read. The report says why.",
  needs_mapping: "is uploaded. Map the unknown names before you apply it.",
  needs_fixes: "has errors. Fix the file and upload it again.",
  ready: "is checked and ready to apply.",
  applied: "is applied.",
};

type UploadCardProps = {
  eventId: string;
  kind: ImportKind;
  latest: LatestImport | null;
  /** Null when uploads are allowed. */
  lockedReason: string | null;
};

export function UploadCard({ eventId, kind, latest, lockedReason }: UploadCardProps) {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [pending, startTransition] = React.useTransition();
  const locked = lockedReason !== null;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) return;
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      toast.error(`${file.name} is larger than 4 MB. Remove extra sheets or columns and try again.`);
      return;
    }
    const formData = new FormData(event.currentTarget);
    formData.set("file", file);
    startTransition(async () => {
      const result = await uploadImport(formData);
      if (!result.ok) {
        toast.error(result.error.message);
        if (result.error.code === "locked") router.refresh();
        return;
      }
      const message = `${file.name} ${UPLOADED_MESSAGES[result.data.state]}`;
      if (result.data.state === "failed" || result.data.state === "needs_fixes") toast.error(message);
      else toast.success(message);
      setFile(null);
      router.push(importHref(eventId, result.data.importId));
    });
  };

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{KIND_LABELS[kind]}</CardTitle>
        <CardDescription>{KIND_DESCRIPTIONS[kind]}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {latest ? (
          <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link href={importHref(eventId, latest.id)} className="min-w-0 font-medium break-all underline-offset-4 hover:underline">
                {latest.fileName}
              </Link>
              <ImportStateBadge state={latest.state} />
            </div>
            {latest.facts.length > 0 ? <p className="text-muted-foreground">{latest.facts.join(", ")}</p> : null}
            <p className="text-xs text-muted-foreground">Uploaded {latest.uploadedLabel}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No file uploaded yet.</p>
        )}
        <form id={`upload-${kind}`} onSubmit={submit} className="flex flex-col gap-3">
          <input type="hidden" name="eventId" value={eventId} />
          <input type="hidden" name="kind" value={kind} />
          <FileDropzone
            accept={ACCEPT}
            file={file}
            onFile={setFile}
            disabled={locked || pending}
            description={locked ? lockedReason : latest ? "A new file replaces this one when you apply it." : undefined}
          />
        </form>
      </CardContent>
      <CardFooter className="mt-auto flex-wrap justify-between gap-2">
        <Button type="submit" form={`upload-${kind}`} disabled={!file || locked || pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
          Upload and check
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <a href={templateHref(kind)} download>
            <DownloadIcon data-icon="inline-start" />
            Download template
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}
