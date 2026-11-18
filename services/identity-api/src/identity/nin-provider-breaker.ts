import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DomainProblem } from '../common/problem';

/** ID-0: failures inside this window count toward tripping the breaker. */
export const NIN_BREAKER_WINDOW_MS = 5 * 60 * 1000;
/** ID-0: this many failures inside the window trip the breaker. */
export const NIN_BREAKER_FAILURE_LIMIT = 3;
/** ID-0: after this long the breaker lets one more check through. */
export const NIN_BREAKER_RETRY_AFTER_MS = 60 * 1000;

/** The log event written for every failed NIN check (no NIN, no name, no date of birth). */
export const NIN_PROVIDER_UNAVAILABLE_EVENT = 'identity.nin_provider.unavailable';

export type NinBreakerState = 'closed' | 'open' | 'retrying';

/**
 * ID-0: remembers, in this process, whether the NIN service has been failing,
 * so the registration desk knows before it asks (registration-capabilities
 * `nin.available`) and a check is not sent while the service is down.
 *
 * - A 503 from the NIN service trips it at once.
 * - Three other failures within 5 minutes trip it.
 * - While tripped, checks are refused without calling the service.
 * - After 60 seconds one check is let through ('retrying'): success closes
 *   the breaker and clears the count; a failure trips it again.
 *
 * A NIN that does not match ("could not be verified") is an answer, not a
 * failure, and does not count.
 */
@Injectable()
export class NinProviderBreaker {
  private readonly logger = new Logger(NinProviderBreaker.name);
  private failures: number[] = [];
  private openedAt: number | null = null;

  state(now = Date.now()): NinBreakerState {
    if (this.openedAt === null) return 'closed';
    return now - this.openedAt >= NIN_BREAKER_RETRY_AFTER_MS ? 'retrying' : 'open';
  }

  /** True unless the breaker is tripped and the 60 seconds have not passed. */
  available(now = Date.now()): boolean {
    return this.state(now) !== 'open';
  }

  /** Refuses a check while the breaker is tripped. */
  assertAvailable(now = Date.now()): void {
    if (this.available(now)) return;
    throw new DomainProblem(503, 'NIN_PROVIDER_UNAVAILABLE',
      'The NIN service is not answering right now. Please try again in a minute.');
  }

  recordSuccess(): void {
    this.failures = [];
    this.openedAt = null;
  }

  /**
   * Counts a failed check and writes the log event. Returns true when it
   * counted (a provider outage); false for a refusal that is not an outage
   * (a 4xx answer), which neither counts nor logs.
   */
  recordFailure(error: unknown, details: { correlationId?: string; provider?: string } = {}, now = Date.now()): boolean {
    const status = statusOf(error);
    if (status !== undefined && status < 500) return false;
    const retrying = this.state(now) === 'retrying';
    this.failures = this.failures.filter((at) => now - at < NIN_BREAKER_WINDOW_MS);
    this.failures.push(now);
    if (status === 503 || retrying || this.failures.length >= NIN_BREAKER_FAILURE_LIMIT) this.openedAt = now;
    this.logger.warn({
      event: NIN_PROVIDER_UNAVAILABLE_EVENT,
      message: 'NIN check failed',
      provider: details.provider,
      code: codeOf(error),
      status: status ?? null,
      failuresInLastFiveMinutes: this.failures.length,
      breaker: this.state(now),
      correlationId: details.correlationId,
    });
    return true;
  }
}

/** The HTTP status of a refusal; undefined for a network or other error (an outage). */
function statusOf(error: unknown): number | undefined {
  return error instanceof HttpException ? error.getStatus() : undefined;
}

function codeOf(error: unknown): string {
  if (error instanceof DomainProblem) return error.code;
  return error instanceof Error ? error.constructor.name : 'UnknownError';
}
