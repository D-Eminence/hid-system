/**
 * Bounded exponential backoff with full jitter, shared by the Textract and
 * Claude clients. Both own their retries (their SDKs run with retries off), so
 * the delay rules live in one place and tests can inject sleep and random.
 */
export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  random?: () => number;
}

/** Full jitter: a uniformly random delay between 0 and min(cap, base * 2^attempt). */
export function fullJitterDelayMs(attempt: number, options: BackoffOptions): number {
  const ceiling = Math.min(options.capMs, options.baseMs * (2 ** Math.max(0, attempt)));
  return Math.floor((options.random ?? Math.random)() * ceiling);
}

export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
