import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { BrandedHeader } from "@/components/app/branded-header";
import { getDb } from "@/db/client";
import { formatEventDate } from "@/lib/time";
import { logoUrl } from "@/server/events/branding";
import { loadParticipantView } from "@/server/exports/participant";
import { ScheduleTable, type ScheduleRow } from "./schedule-table";

// Every request re-checks the token and reads the live schedule. Dynamic
// pages are served with `Cache-Control: private, no-cache, no-store, ...`.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your appointment schedule",
  robots: { index: false, follow: false },
  // The token is in the URL; never send it to another site.
  referrer: "no-referrer",
};

function Footer() {
  return <footer className="text-center text-xs text-muted-foreground sm:text-left">Sent by Dennison &amp; Associates</footer>;
}

export default async function ParticipantSchedulePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // The view is recorded after the response is sent, so the write never holds up the page.
  const view = await loadParticipantView(token, getDb(), { defer: after });
  // One answer for an unknown, revoked, or expired link and a withdrawn person (D44): see ./not-found.tsx.
  if (!view) notFound();

  const { event, person, slots } = view.schedule;
  const isSupplier = person.type === "supplier";
  // Built field by field so nothing beyond name and desk can reach the page (no ranks, scope 2.6).
  const rows: ScheduleRow[] = slots.map((s) => ({
    slot: s.slot,
    start: s.start,
    end: s.end,
    appointment: s.appointment
      ? {
          counterpartName: s.appointment.counterpartName,
          // A supplier's own desk is shown once in the header, not on every row.
          desk: isSupplier ? null : s.appointment.desk,
        }
      : null,
  }));
  const booked = rows.filter((r) => r.appointment).length;

  return (
    <>
      <BrandedHeader
        eventName={event.name}
        dateLabel={formatEventDate(event.eventDate, event.timezone)}
        name={person.name}
        desk={isSupplier ? person.desk : null}
        primaryColor={event.branding?.primaryColor ?? null}
        logoSrc={logoUrl(event.id, event.branding)}
      />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-10 sm:py-10 print:max-w-none print:px-0 print:py-4">
        <section aria-labelledby="appointments-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2 id="appointments-heading" className="font-display text-xl font-bold">
              {booked} of {rows.length} slots booked
            </h2>
            <p className="text-sm text-muted-foreground">
              {isSupplier ? "Your appointments, all at your desk." : "Your appointments, each at the supplier's desk."}
            </p>
          </div>
          <ScheduleTable rows={rows} showDesk={!isSupplier} />
        </section>
        <Footer />
      </main>
    </>
  );
}
