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
          compact ? "gap-4 px-4 py-4" : "max-w-5xl gap-6 px-4 py-6 sm:gap-10 sm:px-10 sm:py-10",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
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
              compact ? "h-16 max-w-[45%] min-w-20 px-3" : "h-20 max-w-[45%] min-w-24 px-4 sm:h-28 sm:max-w-80 sm:min-w-36 sm:px-6",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- served cached by our own route; next/image adds nothing */}
            <img
              src={logoSrc}
              alt={`${eventName} logo`}
              className={cn("max-w-full object-contain", compact ? "max-h-10" : "max-h-12 sm:max-h-20")}
            />
          </div>
        ) : null}
      </div>
    </header>
  );
}
