"use client";

import * as React from "react";
import { ArmchairIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reassignDesksAction } from "@/server/schedule/actions";
import type { DeskAssignment } from "@/server/schedule/lock";

/** "Reassign desks" (D17 while unlocked): confirm, run, then show the resulting desk list. */
export function ReassignDesksButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [desks, setDesks] = React.useState<DeskAssignment[] | null>(null);

  const reassign = async () => {
    const result = await reassignDesksAction(eventId);
    if (!result.ok) {
      toast.error(result.error.message);
      router.refresh();
      return;
    }
    setDesks(result.data.desks);
    router.refresh();
  };

  return (
    <>
      <ConfirmDialog
        title="Reassign desks?"
        description="Desks are numbered alphabetically by supplier name, starting at 1. Suppliers with a desk override keep their number, and that number is skipped for everyone else. Withdrawn suppliers get no desk. Locking does this again, so use it to preview or to fix numbers after a roster change."
        confirmLabel="Reassign desks"
        onConfirm={reassign}
        trigger={
          <Button variant="outline" size="lg">
            <ArmchairIcon data-icon="inline-start" />
            Reassign desks
          </Button>
        }
      />
      <Dialog open={desks !== null} onOpenChange={(open) => !open && setDesks(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-lg font-bold">Desks reassigned</DialogTitle>
            <DialogDescription>
              {desks ? `${desks.filter((d) => d.desk !== null).length} desks assigned. The change is in the activity log.` : null}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60dvh] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 pl-4">Desk</TableHead>
                  <TableHead className="pr-4">Supplier</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...(desks ?? [])]
                  .sort((a, b) => (a.desk ?? Infinity) - (b.desk ?? Infinity))
                  .map((d) => (
                    <TableRow key={d.supplierId}>
                      <TableCell className="pl-4 font-semibold tabular-nums">{d.desk ?? "–"}</TableCell>
                      <TableCell className="pr-4 whitespace-normal">
                        <span className="flex flex-wrap items-center gap-2">
                          {d.name}
                          {d.override ? <Badge variant="outline">Override</Badge> : null}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button onClick={() => setDesks(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
