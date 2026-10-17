import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { PersonSchedule, type PersonScheduleSlot } from "@/components/app/person-schedule";
import { Separator } from "@/components/ui/separator";
import { getDb } from "@/db/client";
import { formatEventDate } from "@/lib/time";
import { loadParticipantView } from "@/server/exports/participant";

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
  return <footer className="pt-2 text-center text-xs text-muted-foreground">Sent by Dennison &amp; Associates</footer>;
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
  const rows: PersonScheduleSlot[] = slots.map((s) => ({
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
    <main className="mx-auto flex w-full max-w-[480px] flex-col gap-6 px-4 py-8 print:max-w-none print:px-0 print:py-0">
      <header className="flex flex-col gap-1">
        <p className="font-display text-sm font-bold tracking-wide text-muted-foreground uppercase">{event.name}</p>
        <p className="text-sm text-muted-foreground">{formatEventDate(event.eventDate, event.timezone)}</p>
        <h1 className="mt-3 font-display text-2xl leading-tight font-bold text-balance break-words">{person.name}</h1>
        {isSupplier && person.desk !== null ? (
          <p className="font-display text-lg font-bold tabular-nums">Desk {person.desk}</p>
        ) : null}
      </header>
      <Separator />
      <section aria-labelledby="appointments-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="appointments-heading" className="text-base font-bold">
            {booked} of {rows.length} slots booked
          </h2>
          <p className="text-sm text-muted-foreground">
            {isSupplier
              ? "Your appointments. Each is ten minutes at your desk."
              : "Your appointments. Each is ten minutes at the supplier's desk."}
          </p>
        </div>
        <PersonSchedule slots={rows} personType={person.type} showRanks={false} className="print:gap-1" />
      </section>
      <Footer />
    </main>
  );
}
