"use client";

import * as React from "react";
import { cn } from "cn";
import { CopyIcon, MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ActionResult } from "@/lib/errors";
import { regenerateTokenAction, revokeTokenAction } from "@/server/tokens/actions";
import type { Health, LinkInfo, StatusFilter } from "./types";

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

const LINK_LABELS = { active: "Link active", revoked: "Revoked", expired: "Expired" } as const;

export function LinkBadge({ link, prefix }: { link: LinkInfo; prefix?: string }) {
  const label = link ? LINK_LABELS[link.state] : "No link";
  return (
    <Badge
      variant={link?.state === "active" ? "secondary" : link?.state === "revoked" ? "destructive" : "outline"}
      title={link ? undefined : "Links are issued when the schedule is locked."}
    >
      {prefix ? `${prefix}: ${label.toLowerCase()}` : label}
    </Badge>
  );
}

export function RosterStatusBadge({ status }: { status: "active" | "withdrawn" }) {
  return <Badge variant={status === "active" ? "outline" : "secondary"}>{status === "active" ? "Active" : "Withdrawn"}</Badge>;
}

/** Count of appointments in the active run, toned against the event's targets. */
export function AppointmentCount({ count, health, hint }: { count: number; health: Health; hint?: string }) {
  if (health === "none") {
    return (
      <span className="text-muted-foreground tabular-nums" title="No active match run yet.">
        –<span className="sr-only">No active match run</span>
      </span>
    );
  }
  if (health === "ok") return <span className="tabular-nums">{count}</span>;
  return (
    <Badge
      variant={health === "low" ? "destructive" : "outline"}
      className={cn("tabular-nums", health === "high" && "border-warning bg-warning/15")}
      title={hint}
    >
      {count}
      {hint ? <span className="sr-only">, {hint}</span> : null}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Keeps a filter in the URL without a navigation, so a refresh or a shared link shows the same view. */
export function useUrlFilter<T extends string>(key: string, initial: T, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = React.useState<T>(initial);
  const update = React.useCallback(
    (next: T) => {
      setValue(next);
      const params = new URLSearchParams(window.location.search);
      if (next === fallback) params.delete(key);
      else params.set(key, next);
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    },
    [key, fallback],
  );
  return [value, update];
}

export function StatusFilterToggle({ value, onChange }: { value: StatusFilter; onChange: (value: StatusFilter) => void }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(next) => next && onChange(next as StatusFilter)}
      aria-label="Status"
    >
      <ToggleGroupItem value="active">Active</ToggleGroupItem>
      <ToggleGroupItem value="withdrawn">Withdrawn</ToggleGroupItem>
      <ToggleGroupItem value="all">All</ToggleGroupItem>
    </ToggleGroup>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Runs an action, toasts the outcome, and refreshes the page on success. Returns whether it worked. */
export function useRunAction() {
  const router = useRouter();
  return React.useCallback(
    async <T,>(work: () => Promise<ActionResult<T>>, success: string): Promise<ActionResult<T>> => {
      const result = await work();
      if (!result.ok) {
        toast.error(result.error.message);
        if (result.error.code === "locked") router.refresh();
        return result;
      }
      toast.success(success);
      router.refresh();
      return result;
    },
    [router],
  );
}

function NewLinkDialog({
  link,
  name,
  onOpenChange,
}: {
  link: string | null;
  name: string;
  onOpenChange: (open: boolean) => void;
}) {
  const inputId = React.useId();
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copied.");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it by hand.");
    }
  };
  return (
    <Dialog open={link !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New link for {name}</DialogTitle>
          <DialogDescription>
            Copy it now. It is shown only once. The old link has stopped working.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={inputId}>Schedule link</FieldLabel>
          <InputGroup>
            <InputGroupInput id={inputId} readOnly value={link ?? ""} onFocus={(event) => event.target.select()} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={copy} aria-label="Copy link">
                <CopyIcon data-icon="inline-start" />
                Copy
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type RowLink = {
  /** "link" for a participant, "admin contact link" for a supplier contact. */
  label: string;
  link: LinkInfo;
};

type PendingDialog =
  | { kind: "withdraw" }
  | { kind: "restore" }
  | { kind: "regenerate"; tokenId: string; label: string }
  | { kind: "revoke"; tokenId: string; label: string };

type RowActionsProps = {
  name: string;
  withdrawn: boolean;
  /** Null when edits are allowed; otherwise why they are not. Links can still be managed. */
  lockedReason: string | null;
  onEdit: () => void;
  withdraw: () => Promise<ActionResult<unknown>>;
  restore: () => Promise<ActionResult<unknown>>;
  links: RowLink[];
};

/** The row menu shared by participants and suppliers: edit, withdraw or restore, and link management. */
export function RosterRowActions({ name, withdrawn, lockedReason, onEdit, withdraw, restore, links }: RowActionsProps) {
  const run = useRunAction();
  const [pending, setPending] = React.useState<PendingDialog | null>(null);
  const [newLink, setNewLink] = React.useState<string | null>(null);
  const locked = lockedReason !== null;
  const issued = links.filter((entry): entry is RowLink & { link: NonNullable<LinkInfo> } => entry.link !== null);

  const close = (open: boolean) => {
    if (!open) setPending(null);
  };

  const confirm = (() => {
    if (!pending) return null;
    switch (pending.kind) {
      case "withdraw":
        return {
          title: `Withdraw ${name}?`,
          description:
            "They are left out of future matching runs, and their appointments in the current schedule become gaps to fill. Their rankings stay, so you can restore them later.",
          confirmLabel: "Withdraw",
          destructive: true,
          onConfirm: async () => {
            await run(withdraw, `${name} is withdrawn.`);
          },
        };
      case "restore":
        return {
          title: `Restore ${name}?`,
          description: "They are included in the next matching run. Gaps already in the current schedule stay until you fill them.",
          confirmLabel: "Restore",
          destructive: false,
          onConfirm: async () => {
            await run(restore, `${name} is active again.`);
          },
        };
      case "regenerate":
        return {
          title: `Regenerate the ${pending.label} for ${name}?`,
          description: "The current link stops working right away. You'll see the new link once, so copy it before you close the window.",
          confirmLabel: "Regenerate link",
          destructive: false,
          onConfirm: async () => {
            const result = await run(() => regenerateTokenAction(pending.tokenId), "New link ready.");
            if (result.ok) setNewLink(result.data.link);
          },
        };
      case "revoke":
        return {
          title: `Revoke the ${pending.label} for ${name}?`,
          description: "The link stops working and they can't open their schedule until you regenerate it.",
          confirmLabel: "Revoke link",
          destructive: true,
          onConfirm: async () => {
            await run(() => revokeTokenAction(pending.tokenId), "Link revoked.");
          },
        };
    }
  })();

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {locked ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel className="max-w-64 font-normal text-muted-foreground">{lockedReason}</DropdownMenuLabel>
            </DropdownMenuGroup>
          ) : null}
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={locked} onSelect={onEdit}>
              Edit
            </DropdownMenuItem>
            {withdrawn ? (
              <DropdownMenuItem disabled={locked} onSelect={() => setPending({ kind: "restore" })}>
                Restore
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={locked} variant="destructive" onSelect={() => setPending({ kind: "withdraw" })}>
                Withdraw
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          {issued.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {issued.map((entry) => (
                  <DropdownMenuItem
                    key={`regenerate-${entry.link.tokenId}`}
                    onSelect={() => setPending({ kind: "regenerate", tokenId: entry.link.tokenId, label: entry.label })}
                  >
                    Regenerate {entry.label}
                  </DropdownMenuItem>
                ))}
                {issued
                  .filter((entry) => entry.link.state === "active")
                  .map((entry) => (
                    <DropdownMenuItem
                      key={`revoke-${entry.link.tokenId}`}
                      variant="destructive"
                      onSelect={() => setPending({ kind: "revoke", tokenId: entry.link.tokenId, label: entry.label })}
                    >
                      Revoke {entry.label}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {confirm ? (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel}
          destructive={confirm.destructive}
          onConfirm={confirm.onConfirm}
        />
      ) : null}
      <NewLinkDialog link={newLink} name={name} onOpenChange={(open) => !open && setNewLink(null)} />
    </div>
  );
}
