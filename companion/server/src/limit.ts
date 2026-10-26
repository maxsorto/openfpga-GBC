/**
 * A small job queue with a concurrency limit and two lanes. Work for what is
 * on screen goes in the high lane and runs before background work.
 */
export type Lane = 'high' | 'low';

interface Task<T> {
  key: string;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  lane: Lane;
}

export class Limiter {
  private active = 0;
  private high: Task<any>[] = [];
  private low: Task<any>[] = [];

  constructor(private readonly max: number) {}

  run<T>(key: string, lane: Lane, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      (lane === 'high' ? this.high : this.low).push({ key, run: fn, resolve, reject, lane });
      this.next();
    });
  }

  /** Move a queued background task to the front, when it is suddenly on screen. */
  promote(key: string): void {
    const i = this.low.findIndex((t) => t.key === key);
    if (i < 0) return;
    const [t] = this.low.splice(i, 1);
    t.lane = 'high';
    this.high.unshift(t);
  }

  /** Drop queued background work that has not started. */
  clearLow(reason = 'Cancelled'): void {
    const dropped = this.low.splice(0);
    for (const t of dropped) t.reject(new Error(reason));
  }

  get pending(): number {
    return this.high.length + this.low.length + this.active;
  }

  private next(): void {
    while (this.active < this.max) {
      const t = this.high.shift() ?? this.low.shift();
      if (!t) return;
      this.active++;
      t.run()
        .then(t.resolve, t.reject)
        .finally(() => {
          this.active--;
          this.next();
        });
    }
  }
}
