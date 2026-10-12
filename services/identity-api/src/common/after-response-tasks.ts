import type { Logger } from '@nestjs/common';

/**
 * How long shutdown waits for work still in flight. The Notification API call
 * times out at 5 s (notification-otp.client.ts); the rest is the database
 * write that records its outcome.
 */
export const AFTER_RESPONSE_SHUTDOWN_GRACE_MS = 6_000;

/**
 * Work a public request starts and does not wait for. A verification-code
 * delivery exists only for a real account or application, so a response that
 * waited for it would tell, by its timing alone, whether one exists
 * (CODEX.md §27). `run` calls the work before it returns, so the delivery
 * request is made during the request that caused it; only its result arrives
 * later. A process that stops before the work finishes loses it, as a failed
 * delivery does, and the user asks for a new code after the cooldown.
 *
 * Nest calls every `beforeApplicationShutdown` hook before any
 * `onApplicationShutdown` hook, so an owner that waits here from
 * `beforeApplicationShutdown` lets the work finish before `DatabaseService`
 * ends the pool.
 */
export class AfterResponseTasks {
  private readonly pending = new Set<Promise<void>>();

  /** `failure` is a fixed sentence: errors are never logged, they can carry a code, a recipient or SQL. */
  constructor(private readonly logger: Logger, private readonly failure: string) {}

  run(correlationId: string, work: () => Promise<void>): void {
    let started: Promise<void>;
    try {
      started = work();
    } catch (error) {
      started = Promise.reject(error);
    }
    const task: Promise<void> = started
      .catch(() => { this.logger.warn(`${this.failure} (correlation ${correlationId})`); })
      .finally(() => { this.pending.delete(task); });
    this.pending.add(task);
  }

  /**
   * Resolves once no work is pending, including work started while it waits,
   * or when `timeoutMs` has passed.
   */
  async settle(timeoutMs = Number.POSITIVE_INFINITY): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const all = Promise.allSettled([...this.pending]);
      if (!Number.isFinite(remaining)) {
        await all;
        continue;
      }
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
        timer.unref();
      });
      await Promise.race([all, expired]);
      clearTimeout(timer);
    }
  }
}
