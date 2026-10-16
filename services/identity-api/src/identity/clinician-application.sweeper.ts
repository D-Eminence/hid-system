import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/** Due applications recorded as expired per run (C15 takes at most 500). */
const EXPIRE_BATCH = 50;

/**
 * Records due clinician applications as expired (C15) and prunes stale
 * capabilities, challenges, idempotency rows and quota counters (C16), every
 * CLINICIAN_APPLICATION_SWEEP_SECONDS (ADR-066). Not security-critical: the
 * reservation, the refusals and the views all compute expiry when they read,
 * so nothing waits for this. Several replicas are safe (SKIP LOCKED). It
 * logs only the SQLSTATE of a failure, and does not run under NODE_ENV=test.
 */
@Injectable()
export class ClinicianApplicationSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(ClinicianApplicationSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    if (this.environment.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.environment.CLINICIAN_APPLICATION_SWEEP_SECONDS * 1_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const correlationId = `clinician-application-sweep-${randomUUID()}`;
    try {
      await this.database.withSystemTransaction(correlationId, (client) =>
        client.query('select identity.expire_clinician_applications($1)', [EXPIRE_BATCH]));
      await this.database.withSystemTransaction(correlationId, (client) =>
        client.query('select identity.prune_clinician_application_artifacts()'));
    } catch (error) {
      // Never log driver messages: they can carry identifiers.
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
      this.logger.error(`Clinician application sweep failed (code=${code}, correlation=${correlationId})`);
    } finally {
      this.running = false;
    }
  }
}
