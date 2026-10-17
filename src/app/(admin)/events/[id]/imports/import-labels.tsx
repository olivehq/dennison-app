import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { ImportKind, ImportState } from "@/lib/schemas/import";

export const KIND_LABELS: Record<ImportKind, string> = {
  participants: "Participants",
  suppliers: "Suppliers",
  buyer_biztech_rankings: "Buyer biztech rankings",
  buyer_hotel_rankings: "Buyer hotel rankings",
  supplier_rankings: "Supplier rankings",
};

/** One line under each upload card title. */
export const KIND_SUMMARIES: Record<ImportKind, string> = {
  participants: "One row per buyer. Email identifies the row.",
  suppliers: "One row per supplier with its type and contacts.",
  buyer_biztech_rankings: "Buyers ranking business suppliers, from eShow.",
  buyer_hotel_rankings: "Buyers ranking hotels, from eShow.",
  supplier_rankings: "Suppliers ranking buyers, from eShow.",
};

/** The full description, behind each upload card's Format button. */
export const KIND_DESCRIPTIONS: Record<ImportKind, string> = {
  participants: "One row per buyer with email, name, organization, title, and biztech opt-in. Email identifies the row.",
  suppliers: "One row per supplier with its type (business or hotel) and the admin and attendee contacts.",
  buyer_biztech_rankings: "The eShow export of buyers ranking business suppliers. Anyone with a choice is opted in to biztech.",
  buyer_hotel_rankings: "The eShow export of buyers ranking hotel suppliers, CHOICE #1 to CHOICE #40.",
  supplier_rankings:
    "The eShow export of suppliers ranking buyers. Each choice can be the buyer's name, company, or email; use the email when two buyers share a name or company. The 2025 matrix layout also works.",
};

export const STATE_LABELS: Record<ImportState, string> = {
  failed: "Failed",
  needs_mapping: "Needs mapping",
  needs_fixes: "Needs fixes",
  ready: "Checked, not applied",
  applied: "Applied",
  ignored: "Ignored",
};

/**
 * Teal for done, marigold for waiting on an admin, oxblood for a file that
 * has to be replaced, muted for nothing to do. "not_uploaded" is the upload
 * card's empty state.
 */
const STATE_TONES: Record<ImportState | "not_uploaded", string> = {
  applied: "bg-hotel-tint text-hotel-ink",
  ready: "bg-business-tint text-business-ink",
  needs_mapping: "bg-business-tint text-business-ink",
  needs_fixes: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  failed: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  ignored: "bg-muted text-muted-foreground",
  not_uploaded: "bg-muted text-muted-foreground",
};

/** The state of a file, with an optional count after it ("Applied · 70 people"). */
export function ImportStateBadge({ state, count }: { state: ImportState | "not_uploaded"; count?: string | null }) {
  const label = state === "not_uploaded" ? "Not uploaded" : STATE_LABELS[state];
  return (
    <Badge variant="secondary" className={cn(STATE_TONES[state])}>
      {count ? `${label} · ${count}` : label}
    </Badge>
  );
}

export function importHref(eventId: string, importId: string): string {
  return `/events/${eventId}/imports/${importId}`;
}

export function templateHref(kind: ImportKind): string {
  return `/api/imports/templates/${kind}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
