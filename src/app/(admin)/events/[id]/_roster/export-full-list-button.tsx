import { eventYear } from "@/server/exports/common";
import { exportFilename } from "@/server/exports/kinds";
import { DownloadButton } from "../exports/download-button";

/** The "Export full list" button in the Participants and Suppliers page headers. Includes withdrawn people, whatever the filters show. */
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
    <DownloadButton
      href={`/api/exports/${eventId}/${segment}`}
      filename={exportFilename(kind, eventYear(eventDate))}
      label="Export full list"
    />
  );
}
