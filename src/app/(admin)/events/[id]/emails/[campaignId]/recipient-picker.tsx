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
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set(value));

  const handleOpenChange = (next: boolean) => {
    if (next) setPicked(new Set(value));
    onOpenChange(next);
  };

  const toggle = React.useCallback((key: string, checked: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

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
              onCheckedChange={(checked) => setPicked(checked === true ? new Set(contacts.map((c) => c.key)) : new Set())}
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onChange(contacts.filter((c) => picked.has(c.key)).map((c) => c.key));
              handleOpenChange(false);
            }}
          >
            Use {recipients(pickedCount)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
