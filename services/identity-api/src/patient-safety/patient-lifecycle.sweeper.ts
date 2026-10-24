import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';

/**
 * How long shutdown waits for a tick beyond EMERGENCY_CONTACT_ALERT_TIMEOUT_MS:
 * the database writes around the alert in flight.
 */
export const PATIENT_LIFECYCLE_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Periodically dispatches emergency-contact notifications while delivery is
 * enabled; no timer runs while it is off. Multiple replicas are safe because
 * claims use row locks with SKIP LOCKED and leases. (main also finalizes due
 * account deletions here; account deletion is not on Novu.)
 */
@Injectable()
export class PatientLifecycleSweeper implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(PatientLifecycleSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  constructor(private readonly dispatcher: EmergencyContactNotificationDispatcher) {}

  onApplicationBootstrap(): void {
    if (!this.environment.EMERGENCY_CONTACT_DELIVERY_ENABLED) return;
    const seconds = this.environment.PATIENT_LIFECYCLE_SWEEP_SECONDS;
    if (seconds === 0) {
      this.logger.warn('Emergency-contact delivery is enabled but PATIENT_LIFECYCLE_SWEEP_SECONDS is 0; '
        + 'no emergency-access alert will be sent');
      return;
    }
    if (this.environment.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.runOnce(); }, seconds * 1_000);
    this.timer.unref();
  }

  /**
   * Runs before DatabaseService ends the pool (after-response-tasks.ts). Stops
   * the timer and the dispatcher, then waits for the tick in flight, so an
   * alert already sent records its outcome instead of being sent again by
   * another task once its lease expires.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.dispatcher.stop();
    if (!this.inFlight) return;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.environment.EMERGENCY_CONTACT_ALERT_TIMEOUT_MS + PATIENT_LIFECYCLE_SHUTDOWN_GRACE_MS);
      timer.unref();
    });
    await Promise.race([this.inFlight, expired]);
    clearTimeout(timer);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs one tick, or returns the tick already running: runs never overlap. */
  runOnce(): Promise<void> {
    this.inFlight ??= this.tick().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async tick(): Promise<void> {
    const correlationId = `patient-lifecycle-${randomUUID()}`;
    try {
      await this.dispatcher.dispatch(correlationId);
    } catch (error) {
      // Never log driver or provider messages: they can contain identifiers.
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
      this.logger.error(`Patient lifecycle sweep failed (code=${code}, correlation=${correlationId})`);
    }
  }
}
