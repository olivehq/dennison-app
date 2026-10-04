/**
 * Per-key sliding-window limiter held in memory. Used by `src/proxy.ts` for
 * participant links. On Vercel each instance has its own memory, so this
 * slows a scraper down rather than enforcing a global cap (see DECISIONS.md).
 */
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastPrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Hard cap on tracked keys, so a flood of spoofed addresses can't grow the map without bound. */
    private readonly maxKeys = 10_000,
  ) {}

  hit(key: string, now: number = Date.now()): RateLimitResult {
    this.prune(now);
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      // Map iteration is insertion order: drop the oldest key.
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    this.hits.set(key, recent);
    return { allowed: true };
  }

  /** Number of keys being tracked. For tests. */
  get size(): number {
    return this.hits.size;
  }

  /** At most once per window, forget keys whose newest hit has left the window. */
  private prune(now: number): void {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    const since = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times[times.length - 1] <= since) this.hits.delete(key);
    }
  }
}

/** The client address as Vercel reports it. Falls back to one shared bucket when there is none. */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return headers.get("x-real-ip")?.trim() || forwarded || "unknown";
}
