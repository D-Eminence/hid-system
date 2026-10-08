import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';
import { PatientAccountDeletionService } from './patient-account-deletion.service';

/**
 * Periodically finalizes patient account deletions whose cancellation window
 * has elapsed and, when enabled, dispatches emergency-contact notifications.
 * A due login is already unusable before this runs; the sweep performs the
 * revocations and completion audit. Multiple replicas are safe because claims
 * use row locks with SKIP LOCKED.
 */
@Injectable()
export class PatientLifecycleSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(PatientLifecycleSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly deletion: PatientAccountDeletionService,
    private readonly dispatcher: EmergencyContactNotificationDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.environment.PATIENT_LIFECYCLE_SWEEP_SECONDS;
    if (seconds === 0 || this.environment.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.runOnce(); }, seconds * 1_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const correlationId = `patient-lifecycle-${randomUUID()}`;
    try {
      await this.deletion.finalizeDue(correlationId);
      await this.dispatcher.dispatch(correlationId);
    } catch (error) {
      // Never log driver or provider messages: they can contain identifiers.
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
      this.logger.error(`Patient lifecycle sweep failed (code=${code}, correlation=${correlationId})`);
    } finally {
      this.running = false;
    }
  }
}
