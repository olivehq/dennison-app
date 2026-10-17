import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { eventYear } from "@/server/exports/common";
import { exportFilename } from "@/server/exports/kinds";

/** The "Export full list" link in the Participants and Suppliers page headers. Includes withdrawn people, whatever the filters show. */
export function ExportFullListButton({
  eventId,
  eventDate,
  kind,
}: {
  eventId: string;
  eventDate: string;
  kind: "participants_full" | "suppliers_full";
}) {
  const segment = kind === "participants_full" ? "participants" : "suppliers";
  return (
    <Button variant="outline" asChild>
      <a href={`/api/exports/${eventId}/${segment}`} download={exportFilename(kind, eventYear(eventDate))}>
        <DownloadIcon data-icon="inline-start" />
        Export full list
      </a>
    </Button>
  );
}
