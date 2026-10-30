import { cn } from "cn";
import { readableOn } from "@/lib/branding";

/**
 * The top of the participant schedule page: event, date, who it is for, and
 * the event's logo and primary color when it has them. Server-safe. Used by
 * `/s/[token]` and by the branding preview on the settings page. Without a
 * primary color it renders as plain text, as it did before branding existed.
 */
export function BrandedHeader({
  eventName,
  dateLabel,
  name,
  desk,
  primaryColor,
  logoSrc,
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
  className?: string;
}) {
  return (
    <header
      data-slot="branded-header"
      className={cn("flex items-start gap-4", primaryColor && "rounded-md border border-t-8 p-4", className)}
      style={
        primaryColor
          ? {
              borderColor: `color-mix(in oklab, ${primaryColor} 35%, var(--border))`,
              borderTopColor: primaryColor,
              backgroundColor: `color-mix(in oklab, ${primaryColor} 8%, var(--card))`,
            }
          : undefined
      }
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-display text-sm font-bold tracking-wide text-muted-foreground uppercase">{eventName}</p>
        <p className="text-sm text-muted-foreground">{dateLabel}</p>
        <h1 className="mt-3 font-display text-2xl leading-tight font-bold text-balance break-words">{name}</h1>
        {desk !== null ? (
          <p
            className={cn("font-display text-lg font-bold tabular-nums", primaryColor && "mt-1 w-fit rounded-md px-2.5 py-0.5")}
            style={primaryColor ? { backgroundColor: primaryColor, color: readableOn(primaryColor) } : undefined}
          >
            Desk {desk}
          </p>
        ) : null}
      </div>
      {logoSrc ? (
        // eslint-disable-next-line @next/next/no-img-element -- served cached by our own route; next/image adds nothing
        <img src={logoSrc} alt={`${eventName} logo`} className="max-h-20 max-w-[40%] shrink-0 object-contain" />
      ) : null}
    </header>
  );
}
