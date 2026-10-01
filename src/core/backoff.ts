export type Outcome = "messages" | "idle" | "rateLimited" | "error";

export interface BackoffOptions {
  baseMs: number;
  /** Cap for idle and error delays. Default 6x base. */
  maxMs?: number;
  /** Cap for rate-limit delays. Default 5 minutes. */
  rateLimitMaxMs?: number;
}

// Poll delay that slows down while nothing happens, backs off hard when Mizito pushes back, and resets on activity.
export class Backoff {
  private current: number;
  private readonly maxMs: number;
  private readonly rateMaxMs: number;

  constructor(private readonly o: BackoffOptions) {
    this.current = o.baseMs;
    this.maxMs = o.maxMs ?? o.baseMs * 6;
    this.rateMaxMs = Math.max(this.maxMs, o.rateLimitMaxMs ?? 300_000);
  }

  /** Record the outcome of a poll; returns how long to wait before the next one. */
  next(outcome: Outcome): number {
    switch (outcome) {
      case "messages":
        this.current = this.o.baseMs;
        break;
      case "idle":
        this.current = this.current > this.maxMs ? this.maxMs : Math.min(this.maxMs, Math.round(this.current * 1.5));
        break;
      case "error":
        this.current = Math.min(this.maxMs, this.current * 2);
        break;
      case "rateLimited":
        this.current = Math.min(this.rateMaxMs, Math.max(this.current, this.o.baseMs) * 2);
        break;
    }
    return this.current;
  }
}
