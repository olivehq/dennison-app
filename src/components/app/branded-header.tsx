import { cn } from "cn";
import { readableOn } from "@/lib/branding";

/**
 * The band at the top of the participant schedule page: event, date, who it is
 * for, and the event's logo. The band takes the event's main color, with black
 * or white text for contrast. Without a color it is the dark neutral, and
 * without a logo there is no logo chip. The logo sits on a white chip so a logo
 * made for a white page reads on any color. Server-safe. Used by `/s/[token]`
 * and by the branding preview on the settings page (`compact`).
 */
export function BrandedHeader({
  eventName,
  dateLabel,
  name,
  desk,
  primaryColor,
  logoSrc,
  compact = false,
  className,
}: {
  eventName: string;
  dateLabel: string;
  name: string;
  /** The supplier's desk. Null for buyers. */
  desk: number | null;
  primaryColor: string | null;
  /** The logo's URL: the branding route, or a blob URL in the settings preview. */
  logoSrc: string | null;
  /** A smaller band for the settings preview. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <header
      data-slot="branded-header"
      className={cn("w-full print:bg-transparent print:text-foreground", className)}
      style={{
        backgroundColor: primaryColor ?? "var(--foreground)",
        color: primaryColor ? readableOn(primaryColor) : "var(--background)",
      }}
    >
      <div
        className={cn(
          "mx-auto flex items-center",
          // Below 768px the logo sits on its own row above the text, so a long name gets the full width.
          compact ? "gap-4 px-4 py-4" : "max-w-5xl flex-col items-start gap-5 px-4 py-5 sm:px-10 sm:py-8 md:flex-row md:items-center md:gap-10 md:py-10",
        )}
      >
        <div className={cn("flex min-w-0 flex-col gap-2", compact ? "flex-1" : "w-full md:w-auto md:flex-1")}>
          <p className={cn("font-display font-bold tracking-wide uppercase opacity-80", compact ? "text-xs" : "text-xs sm:text-sm")}>
            {eventName} <span aria-hidden="true">·</span> {dateLabel}
          </p>
          <h1
            className={cn(
              "font-display leading-tight font-bold text-balance break-words",
              compact ? "text-xl" : "text-2xl sm:text-4xl",
            )}
          >
            {name}
          </h1>
          {desk !== null ? (
            <p className={cn("font-display font-bold tabular-nums", compact ? "text-base" : "text-xl sm:text-2xl")}>Desk {desk}</p>
          ) : null}
        </div>
        {logoSrc ? (
          <div
            className={cn(
              "flex shrink-0 items-center justify-center rounded-xl bg-white shadow-sm",
              compact ? "h-16 max-w-[45%] min-w-20 px-3" : "order-first h-14 max-w-full px-4 md:order-last md:h-28 md:max-w-80 md:min-w-36 md:px-6",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- served cached by our own route; next/image adds nothing */}
            <img
              src={logoSrc}
              alt={`${eventName} logo`}
              className={cn("max-w-full object-contain", compact ? "max-h-10" : "max-h-8 md:max-h-20")}
            />
          </div>
        ) : null}
      </div>
    </header>
  );
}
