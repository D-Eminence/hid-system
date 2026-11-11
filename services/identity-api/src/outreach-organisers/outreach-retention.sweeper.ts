import { randomUUID } from 'node:crypto';
import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/** Registrations redacted per sweep at most (0116 accepts 1-5000). */
export const OUTREACH_RETENTION_SWEEP_BATCH = 500;

/**
 * The outreach retention sweeper (plan PR-2/PR-4, owner decision 3 of 11 Nov
 * 2026): every OUTREACH_RETENTION_SWEEP_SECONDS it calls 0116's
 * identity.sweep_expired_outreach_registrations(500) as system:auth, the only
 * context it accepts (EXECUTE is granted to Identity's runtime only). The
 * function redacts, never deletes, the registrations of outreach groups never
 * linked to a Health ID whose campaign's retain_until has passed (closed_at +
 * 365 days, or starts_at + 365 days for a campaign never closed), drops
 * unfinished sign-ups older than 30 days, and drops invitations never
 * accepted 30 days after they expired or were cancelled. It decides what is due; the batch
 * only bounds one run. Several replicas are safe: it locks what it redacts.
 * A failure is logged by its SQLSTATE only, as an error.
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

  /** One sweep: the number of registrations redacted, or null when it failed. Never throws; runs never overlap. */
  runOnce(): Promise<number | null> {
    this.inFlight ??= this.sweep().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async sweep(): Promise<number | null> {
    const correlationId = `outreach-retention-${randomUUID()}`;
    try {
      const redacted = await this.database.withSystemTransaction(correlationId, async (client) =>
        Number((await client.query<{ redacted: number | string | null }>(
          'select identity.sweep_expired_outreach_registrations($1) as redacted', [OUTREACH_RETENTION_SWEEP_BATCH]))
          .rows[0]?.redacted ?? 0));
      if (redacted > 0) {
        this.logger.log(`Outreach registrations redacted after their year (event=outreach_retention_sweep count=${redacted})`);
      }
      return redacted;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code) : 'none';
      this.logger.error(`Outreach retention sweep failed (event=outreach_retention_sweep_failed code=${/^[0-9A-Z]{5}$/.test(code) ? code : 'none'}, correlation=${correlationId})`);
      return null;
    }
  }
}
