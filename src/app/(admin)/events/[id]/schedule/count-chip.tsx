import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { Health } from "./schedule-model";

/** A person's meeting count. Destructive below or off target, warning above. */
export function CountChip({ count, health, className }: { count: number; health: Health; className?: string }) {
  return (
    <Badge
      variant={health === "ok" ? "outline" : "default"}
      data-health={health}
      className={cn(
        "min-w-6 px-1.5 font-bold tabular-nums",
        health === "ok" && "text-muted-foreground",
        (health === "under" || health === "off") && "bg-destructive text-destructive-foreground",
        health === "over" && "bg-warning text-warning-foreground",
        className,
      )}
    >
      {count}
    </Badge>
  );
}

/** The inset bar on a lane label: destructive for under or off target, warning for over. */
export function healthInset(health: Health): string | false {
  if (health === "under" || health === "off") return "shadow-[inset_3px_0_0_var(--color-destructive)]";
  if (health === "over") return "shadow-[inset_3px_0_0_var(--color-warning)]";
  return false;
}
