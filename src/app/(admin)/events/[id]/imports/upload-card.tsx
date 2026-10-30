"use client";

import * as React from "react";
import { cn } from "cn";
import { DownloadIcon, FileIcon, InfoIcon, UploadIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import {
  IMPORT_FILE_EXTENSIONS,
  IMPORT_MAX_FILE_BYTES,
  isRankingKind,
  type ImportKind,
  type ImportState,
} from "@/lib/schemas/import";
import { uploadImport } from "@/server/imports/actions";
import { ImportStateBadge, importHref, KIND_DESCRIPTIONS, KIND_LABELS, KIND_SUMMARIES, templateHref } from "./import-labels";
import type { UploadCardState } from "./upload-card-state";

/** The file the card is about: the latest one of its kind that isn't ignored, else the latest ignored one. */
export type LatestImport = {
  id: string;
  fileName: string;
  uploadedLabel: string;
};

const ACCEPT = [...IMPORT_FILE_EXTENSIONS];

const UPLOADED_MESSAGES: Record<ImportState, string> = {
  failed: "couldn't be read. The report says why.",
  needs_mapping: "is uploaded. Map the unknown names before you apply it.",
  needs_fixes: "has errors. Fix the file and upload it again.",
  ready: "is checked and ready to apply.",
  applied: "is applied.",
  ignored: "is ignored.",
};

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPT.some((ext) => lower.endsWith(ext));
}

type UploadCardProps = {
  eventId: string;
  kind: ImportKind;
  latest: LatestImport | null;
  state: UploadCardState;
  /** Null when uploads are allowed. */
  lockedReason: string | null;
};

/**
 * One file kind on the Upload page: its state, the last upload, and one
 * action. The whole card takes a dropped file; nothing is sent until
 * "Upload and check".
 */
export function UploadCard({ eventId, kind, latest, state, lockedReason }: UploadCardProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [rejected, setRejected] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const locked = lockedReason !== null;
  const disabled = locked || pending;
  const label = KIND_LABELS[kind];

  const take = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!hasAcceptedExtension(candidate.name)) {
      setRejected(candidate.name);
      return;
    }
    setRejected(null);
    setFile(candidate);
  };

  const choose = () => inputRef.current?.click();

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

  const replaceNote = !latest
    ? null
    : isRankingKind(kind)
      ? "Applying it changes the rankings of only the people in it."
      : "Applying it replaces the current file.";

  return (
    <Card
      size="sm"
      data-dragging={dragging || undefined}
      className={cn(
        "relative min-w-0 transition-shadow motion-reduce:transition-none",
        "data-dragging:bg-accent/60 data-dragging:ring-2 data-dragging:ring-ring",
      )}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Leaving for a child element is not leaving the card.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragging(false);
        take(event.dataTransfer.files[0]);
      }}
    >
      <CardHeader>
        <CardTitle className="text-base">{label}</CardTitle>
        <CardDescription>{KIND_SUMMARIES[kind]}</CardDescription>
        <CardAction>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`${label} file format and template`}>
                <InfoIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <PopoverHeader>
                <PopoverTitle>{label} file</PopoverTitle>
                <PopoverDescription>{KIND_DESCRIPTIONS[kind]}</PopoverDescription>
              </PopoverHeader>
              <p className="text-xs text-muted-foreground">
                {ACCEPT.join(", ")} up to 4 MB. Drop the file on the card or choose it. The template has one example row; replace it with
                your data.
              </p>
              <Button variant="outline" size="sm" className="self-start" asChild>
                <a href={templateHref(kind)} download>
                  <DownloadIcon data-icon="inline-start" />
                  Download template
                </a>
              </Button>
            </PopoverContent>
          </Popover>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-col items-start gap-1.5">
          <ImportStateBadge state={state.pill} count={state.count} />
          {latest ? (
            <p className="text-xs text-muted-foreground">
              <Link href={importHref(eventId, latest.id)} className="font-medium break-all text-foreground underline-offset-4 hover:underline">
                {latest.fileName}
              </Link>
              <span className="block">Uploaded {latest.uploadedLabel}</span>
            </p>
          ) : null}
        </div>

        <form onSubmit={submit} className="mt-auto flex flex-col gap-2">
          <input type="hidden" name="eventId" value={eventId} />
          <input type="hidden" name="kind" value={kind} />
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT.join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            disabled={disabled}
            onChange={(event) => {
              take(event.target.files?.[0]);
              // Reset so choosing the same file again still fires onChange.
              event.target.value = "";
            }}
          />
          {file ? (
            <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-2 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 break-all">{file.name}</span>
              </span>
              {replaceNote ? <span className="text-xs text-muted-foreground">{replaceNote}</span> : null}
            </div>
          ) : null}
          {rejected ? (
            <p role="alert" className="text-sm text-destructive">
              {rejected} is not a {ACCEPT.join(" or ")} file. Choose a different file.
            </p>
          ) : null}
          {locked ? <p className="text-xs text-muted-foreground">{lockedReason}</p> : null}

          <div className="flex flex-wrap items-center gap-2">
            {file ? (
              <>
                <Button type="submit" size="sm" disabled={disabled}>
                  {pending ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
                  Upload and check
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setFile(null)}>
                  <XIcon data-icon="inline-start" />
                  Cancel
                </Button>
              </>
            ) : state.action.kind === "review" && latest ? (
              <>
                <Button size="sm" asChild>
                  <Link href={importHref(eventId, latest.id)}>{state.action.label}</Link>
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={choose}>
                  Upload new file
                </Button>
              </>
            ) : (
              <Button
                type="button"
                // Only a file that has to be replaced gets the filled button; the rest stay quiet.
                variant={state.pill === "needs_fixes" || state.pill === "failed" ? "default" : "outline"}
                size="sm"
                disabled={disabled}
                onClick={choose}
              >
                <UploadIcon data-icon="inline-start" />
                {state.action.label}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-accent/80 text-sm font-medium">
          Drop to choose this {label.toLowerCase()} file
        </div>
      ) : null}
    </Card>
  );
}
