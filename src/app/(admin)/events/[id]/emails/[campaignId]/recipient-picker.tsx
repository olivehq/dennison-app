"use client";

import * as React from "react";
import { createDataTableColumnHelper, DataTable } from "@/components/app/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AudienceOption } from "@/server/email/queries";
import { recipients } from "../labels";
import { pickedKeys, pickerReducer } from "./recipient-picker-state";

const CONTACT_LABELS = { buyer: "Buyer", supplier_admin: "Supplier admin", supplier_attendee: "Supplier attendee" } as const;

const helper = createDataTableColumnHelper<AudienceOption>();

type RecipientPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contacts: AudienceOption[];
  value: string[];
  onChange: (keys: string[]) => void;
};

/** "Selected people": a checkbox table of every contact who can be emailed. */
export function RecipientPicker({ open, onOpenChange, contacts, value, onChange }: RecipientPickerProps) {
  const [{ open: syncedOpen, picked }, dispatch] = React.useReducer(pickerReducer, null, () => ({
    open,
    picked: new Set(value),
  }));
  // The parent opens the dialog itself, so reset to the saved choice whenever `open` turns true.
  if (syncedOpen !== open) dispatch({ type: "sync", open, value });

  const toggle = React.useCallback((key: string, checked: boolean) => dispatch({ type: "toggle", key, checked }), []);

  const pickedCount = contacts.filter((c) => picked.has(c.key)).length;
  const allPicked = contacts.length > 0 && pickedCount === contacts.length;
  const somePicked = !allPicked && pickedCount > 0;

  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.display({
          id: "pick",
          enableSorting: false,
          header: () => (
            <Checkbox
              aria-label="Select everyone"
              checked={allPicked ? true : somePicked ? "indeterminate" : false}
              onCheckedChange={(checked) => dispatch({ type: "replace", keys: checked === true ? contacts.map((c) => c.key) : [] })}
            />
          ),
          cell: ({ row }) => (
            <Checkbox
              aria-label={`Select ${row.original.name}`}
              checked={picked.has(row.original.key)}
              onCheckedChange={(checked) => toggle(row.original.key, checked === true)}
            />
          ),
        }),
        helper.accessor("name", {
          header: "Name",
          sortFn: "name",
          cell: ({ row }) => <span className="block max-w-sm font-medium whitespace-normal">{row.original.name}</span>,
        }),
        helper.accessor("email", { header: "Email" }),
        helper.accessor((row) => CONTACT_LABELS[row.contactType], {
          id: "type",
          header: "Type",
          cell: ({ row }) => <Badge variant="outline">{CONTACT_LABELS[row.original.contactType]}</Badge>,
        }),
      ]),
    [allPicked, somePicked, contacts, picked, toggle],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Choose recipients</DialogTitle>
          <DialogDescription>
            Active buyers and supplier contacts with an email address. Withdrawn people are not listed.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <DataTable
            columns={columns}
            data={contacts}
            getRowId={(row) => row.key}
            searchColumns={["name", "email"]}
            searchPlaceholder="Search by name or email"
            pageSize={200}
            emptyTitle="Nobody to email yet"
            emptyDescription="Add participants and suppliers with email addresses first."
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onChange(pickedKeys(contacts, picked));
              onOpenChange(false);
            }}
          >
            Use {recipients(pickedCount)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
