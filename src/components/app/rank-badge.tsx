import { cn } from "cn";

type RankBadgeProps = {
  /** B is the buyer's rank of the supplier, S is the supplier's rank of the buyer. */
  side: "B" | "S";
  rank: number | null;
  /** Ranks at or under this are highlighted (the event's mutualTopN). */
  topN: number;
  className?: string;
};

/** "B:4", "S:–". Highlighted when the rank is within the top N. */
export function RankBadge({ side, rank, topN, className }: RankBadgeProps) {
  const top = rank !== null && rank >= 1 && rank <= topN;
  const who = side === "B" ? "Buyer rank" : "Supplier rank";
  return (
    <span
      data-slot="rank-badge"
      data-top={top || undefined}
      title={rank === null ? `${who} left blank` : `${who} ${rank}${top ? `, top ${topN}` : ""}`}
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-sm px-1 text-xs font-semibold whitespace-nowrap tabular-nums",
        top ? "bg-primary text-primary-foreground" : "text-current opacity-85 ring-1 ring-current/25 ring-inset",
        className,
      )}
    >
      <span className="sr-only">{who} </span>
      <span aria-hidden="true">{side}:</span>
      {rank === null ? (
        <>
          <span aria-hidden="true">–</span>
          <span className="sr-only">blank</span>
        </>
      ) : (
        rank
      )}
    </span>
  );
}
