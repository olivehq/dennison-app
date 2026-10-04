"use client";

import * as React from "react";
import { cn } from "cn";
import { FileIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type FileDropzoneProps = {
  /** Accepted extensions with the dot, for example [".csv", ".xlsx"]. */
  accept: string[];
  /** The file currently chosen, if the parent keeps it. */
  file?: File | null;
  onFile: (file: File) => void;
  disabled?: boolean;
  /** One line under the prompt, for example "The participants export from eShow". */
  description?: React.ReactNode;
  className?: string;
};

function hasAcceptedExtension(name: string, accept: string[]): boolean {
  const lower = name.toLowerCase();
  return accept.some((ext) => lower.endsWith(ext.toLowerCase()));
}

export function FileDropzone({ accept, file, onFile, disabled, description, className }: FileDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [rejected, setRejected] = React.useState<string | null>(null);

  const take = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!hasAcceptedExtension(candidate.name, accept)) {
      setRejected(candidate.name);
      return;
    }
    setRejected(null);
    onFile(candidate);
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        data-dragging={dragging || undefined}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragging(false);
          take(event.dataTransfer.files[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-card px-4 py-8 text-center transition-colors outline-none",
          "hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "data-dragging:border-ring data-dragging:bg-accent",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept.join(",")}
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          onChange={(event) => {
            take(event.target.files?.[0]);
            // Reset so choosing the same file again still fires onChange.
            event.target.value = "";
          }}
        />
        {file ? (
          <>
            <FileIcon className="size-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium break-all">{file.name}</p>
            <p className="text-xs text-muted-foreground">Drop another file to replace it</p>
          </>
        ) : (
          <>
            <UploadIcon className="size-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Drop a file here or choose one</p>
            <p className="text-xs text-muted-foreground">{accept.join(", ")}</p>
          </>
        )}
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {rejected ? (
        <p role="alert" className="text-sm text-destructive">
          {rejected} is not a {accept.join(" or ")} file. Choose a different file.
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        Choose file
      </Button>
    </div>
  );
}
