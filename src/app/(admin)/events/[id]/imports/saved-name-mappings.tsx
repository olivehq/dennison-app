"use client";

import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { removeAliasAction } from "@/server/imports/actions";
import type { SavedNameMapping } from "@/server/imports/queries";

/** Where a mapping applies, in the words the list and the confirm use. */
export function mappingReach(mapping: Pick<SavedNameMapping, "scope" | "crossYear">): string {
  if (mapping.scope === "cross_year") return "Every event";
  return mapping.crossYear ? "This event and later events" : "This event";
}

function removeDescription(mapping: SavedNameMapping): string {
  const what = `Files that say “${mapping.rawText}” will no longer read it as ${mapping.mapsTo}.`;
  if (mapping.scope === "cross_year") {
    return `${what} This mapping was saved in another event and applies to every event, so removing it here removes it everywhere. Pending files of this event are checked again.`;
  }
  return mapping.crossYear
    ? `${what} The copy saved for later events goes too. Pending files of this event are checked again.`
    : `${what} Pending files of this event are checked again.`;
}

type SavedNameMappingsProps = {
  eventId: string;
  mappings: SavedNameMapping[];
  lockedReason: string | null;
};

/**
 * Saved name mappings that apply to this event, with Remove. A name on the
 * roster always beats a mapping, so a mapping only reads text nobody on the
 * roster has as their name.
 */
export function SavedNameMappings({ eventId, mappings, lockedReason }: SavedNameMappingsProps) {
  const remove = async (mapping: SavedNameMapping) => {
    const result = await removeAliasAction({ eventId, aliasId: mapping.id });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(`Removed the mapping for “${mapping.rawText}”.`);
  };

  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Name in the file</TableHead>
            <TableHead>Maps to</TableHead>
            <TableHead>Applies to</TableHead>
            <TableHead>
              <span className="sr-only">Remove</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mappings.map((mapping) => (
            <TableRow key={mapping.id}>
              <TableCell className="font-medium whitespace-normal">{mapping.rawText}</TableCell>
              <TableCell className="whitespace-normal">{mapping.mapsTo}</TableCell>
              <TableCell className="text-muted-foreground">
                {mappingReach(mapping)}
                {mapping.source === "auto" ? <span className="block text-xs">Saved when a file was applied</span> : null}
              </TableCell>
              <TableCell className="text-right">
                <ConfirmDialog
                  title={`Remove the mapping for “${mapping.rawText}”?`}
                  description={removeDescription(mapping)}
                  confirmLabel="Remove mapping"
                  destructive
                  onConfirm={() => remove(mapping)}
                  trigger={
                    <Button variant="ghost" size="sm" disabled={lockedReason !== null}>
                      Remove
                    </Button>
                  }
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
