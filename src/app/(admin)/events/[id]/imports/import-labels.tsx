import { Badge } from "@/components/ui/badge";
import type { ImportKind, ImportState } from "@/lib/schemas/import";

export const KIND_LABELS: Record<ImportKind, string> = {
  participants: "Participants",
  suppliers: "Suppliers",
  buyer_biztech_rankings: "Buyer biztech rankings",
  buyer_hotel_rankings: "Buyer hotel rankings",
  supplier_rankings: "Supplier rankings",
};

/** One line under each upload card title: what the file is. */
export const KIND_DESCRIPTIONS: Record<ImportKind, string> = {
  participants: "One row per buyer with email, name, organization, title, and biztech opt-in. Email identifies the row.",
  suppliers: "One row per supplier with its type (business or hotel) and the admin and attendee contacts.",
  buyer_biztech_rankings: "The eShow export of buyers ranking business suppliers. Anyone with a choice is opted in to biztech.",
  buyer_hotel_rankings: "The eShow export of buyers ranking hotel suppliers, CHOICE #1 to CHOICE #40.",
  supplier_rankings: "The eShow export of suppliers ranking buyers. The 2025 matrix layout also works.",
};

const STATE_LABELS: Record<ImportState, string> = {
  failed: "Failed",
  needs_mapping: "Needs mapping",
  needs_fixes: "Needs fixes",
  ready: "Ready",
  applied: "Applied",
};

const STATE_VARIANTS: Record<ImportState, "destructive" | "outline" | "secondary" | "default"> = {
  failed: "destructive",
  needs_mapping: "outline",
  needs_fixes: "destructive",
  ready: "secondary",
  applied: "default",
};

export function ImportStateBadge({ state }: { state: ImportState }) {
  return <Badge variant={STATE_VARIANTS[state]}>{STATE_LABELS[state]}</Badge>;
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
