/**
 * A counting semaphore with FIFO waiters. The worker holds one per external API for the whole process (Claude:
 * OCR_AI_MAX_CONCURRENT_REQUESTS, Textract: OCR_TEXTRACT_MAX_CONCURRENT), shared by every claim loop, so the
 * number of calls in flight never exceeds the account's budget however many jobs are being read.
 *
 * A permit is held only for one API call, never across a backoff sleep or a Textract poll delay. Waiting does
 * not block the event loop, so a job's lease renewal keeps running while it waits. An aborted wait leaves the
 * queue and takes no permit.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Semaphore limit must be a positive integer');
  }

  /** Calls in flight now. */
  get inFlight(): number { return this.active; }
  /** Callers waiting for a permit now. */
  get waiting(): number { return this.waiters.length; }

  /** Waits for a permit and returns its release (idempotent). Rejects with the signal's reason on abort. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = { grant: () => { signal?.removeEventListener('abort', onAbort); resolve(this.releaser()); } };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Runs one call while holding a permit. */
  async run<Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally { release(); }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // The permit passes straight to the next waiter; active stays the same.
      if (next) next.grant();
      else this.active -= 1;
    };
  }
}

/**
 * Runs tasks over items with at most `limit` running at once, in item order. After the first failure no new
 * task starts; the ones already running are awaited (so their side effects, such as token usage, are counted)
 * and then the first failure is thrown.
 */
export async function forEachBounded<Item>(items: readonly Item[], limit: number,
  task: (item: Item) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async () => {
    while (failure === null && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failure !== null) throw (failure as { error: unknown }).error;
}
