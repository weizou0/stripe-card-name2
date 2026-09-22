/**
 * Token bucket limiter: at most `rps` acquisitions per rolling second,
 * shared by every Stripe request the script makes.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillMs: number;
  private readonly waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly rps: number,
    private readonly burst: number = rps,
  ) {
    if (rps <= 0) throw new Error('rps must be greater than 0');
    this.tokens = burst;
    this.lastRefillMs = Date.now();
  }

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  get pending(): number {
    return this.waiters.length;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    this.lastRefillMs = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1000) * this.rps);
  }

  private drain(): void {
    this.refill();

    while (this.tokens >= 1) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      this.tokens -= 1;
      waiter();
    }

    if (this.waiters.length > 0 && this.timer === undefined) {
      const waitMs = Math.max(5, Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, waitMs);
      this.timer.unref?.();
    }
  }
}
