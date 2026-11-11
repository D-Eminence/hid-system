import { randomUUID } from 'node:crypto';
import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/**
 * The retention sweeper (plan PR-2/PR-4, owner decision 3 of 11 Nov 2026):
 * every OUTREACH_RETENTION_SWEEP_SECONDS it calls
 * outreach.sweep_expired_registrations(), which redacts (never deletes) the
 * registrations never linked to a Health ID whose campaign's retain_until has
 * passed: closed_at + 365 days, or starts_at + 365 days for a campaign never
 * closed. The function decides what is due and takes no input, so this call
 * cannot widen what is redacted. Several replicas are safe: the function
 * locks what it redacts. Each failure is logged by its SQLSTATE only.
 */
@Injectable()
export class OutreachRetentionSweeper implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(OutreachRetentionSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number | null>;

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    const seconds = this.environment.OUTREACH_RETENTION_SWEEP_SECONDS;
    if (seconds === 0 || this.environment.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.runOnce(); }, seconds * 1_000);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** One sweep: the number of registrations redacted, or null when it failed. Never throws. */
  runOnce(): Promise<number | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sweep().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async sweep(): Promise<number | null> {
    try {
      const redacted = await this.database.withRetentionTransaction(`outreach-retention-${randomUUID()}`, async (client) =>
        Number((await client.query<{ redacted: number | string | null }>(
          'select outreach.sweep_expired_registrations() as redacted')).rows[0]?.redacted ?? 0));
      if (redacted > 0) this.logger.log(`Outreach registrations redacted after their retention ended (event=outreach_retention_sweep count=${redacted})`);
      return redacted;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code) : 'none';
      this.logger.warn(`Outreach retention sweep failed (event=outreach_retention_sweep_failed code=${/^[0-9A-Z]{5}$/.test(code) ? code : 'none'})`);
      return null;
    }
  }
}
