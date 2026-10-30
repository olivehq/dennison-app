import { cn } from "cn";

/** The slot-ruler mark: three slots, the middle one dimmed, with the now line over the first. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground",
        className,
      )}
    >
      <svg viewBox="0 0 20 20" className="size-5" fill="currentColor">
        <rect x="1" y="7" width="5.5" height="6" rx="3" />
        <rect x="7.25" y="7" width="5.5" height="6" rx="3" opacity=".45" />
        <rect x="13.5" y="7" width="5.5" height="6" rx="3" />
        <rect x="9.4" y="3" width="1.2" height="14" rx=".6" className="fill-now" />
      </svg>
    </span>
  );
}
