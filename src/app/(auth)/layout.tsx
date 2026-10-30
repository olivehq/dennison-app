import { cn } from "cn";
import { Card } from "@/components/ui/card";
import { AppTheme } from "../app-theme";
import { AwMark } from "./auth-shell";

/** Nine slots of a day: open, hotel, and business, with the now line over the fifth. */
const RULER = ["open", "hotel", "open", "business", "business", "open", "hotel", "business", "open"] as const;
const NOW_SLOT = 4;

const RULER_TONE = {
  open: "bg-open/40",
  hotel: "bg-hotel",
  business: "bg-business",
} as const;

function SlotRuler() {
  return (
    <div aria-hidden className="flex w-full max-w-sm gap-1.5 pt-2">
      {RULER.map((tone, index) => (
        <span key={index} className={cn("relative h-2 flex-1 rounded-full", RULER_TONE[tone])}>
          {index === NOW_SLOT ? (
            <span className="absolute -top-2 -bottom-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-now" />
          ) : null}
        </span>
      ))}
    </div>
  );
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppTheme>
      <main className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,28rem)]">
        <section className="hidden border-r bg-card p-10 lg:flex lg:flex-col lg:justify-between">
          <AwMark />
          <div className="flex max-w-xl flex-col gap-4">
            <p className="font-display text-5xl leading-[1.05] font-extrabold tracking-[-0.03em] text-balance">
              Every meeting, matched and scheduled.
            </p>
            <p className="text-base text-muted-foreground">
              Load the files, run matching, check the schedule, then send each participant their link.
            </p>
            <SlotRuler />
          </div>
          <p className="text-xs text-muted-foreground">Built by Olive Technologies for Dennison &amp; Associates.</p>
        </section>
        <div className="flex flex-col items-center gap-6 px-4 pt-10 pb-8 sm:pt-16 lg:justify-center lg:px-10 lg:py-10">
          <AwMark className="lg:hidden" />
          <Card className="w-full max-w-sm lg:bg-transparent lg:shadow-none lg:ring-0">{children}</Card>
        </div>
      </main>
    </AppTheme>
  );
}
