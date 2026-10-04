const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private active = 0;
  private waiters: Array<() => void> = [];
  private pausedUntil = 0;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly maxConcurrency: number,
  ) {
    this.tokens = burst;
  }

  /** Called when the server says "slow down" so every in-flight caller backs off, not just the one that got the 429. */
  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.acquireToken();
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async acquireSlot() {
    while (this.active >= this.maxConcurrency) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.active++;
  }

  private async acquireToken() {
    for (;;) {
      const pause = this.pausedUntil - Date.now();
      if (pause > 0) {
        await sleep(pause);
        continue;
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
    }
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSecond);
    this.lastRefill = now;
  }
}
