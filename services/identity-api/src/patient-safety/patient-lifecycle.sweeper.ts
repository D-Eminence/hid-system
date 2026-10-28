import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, Optional,
} from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AccountDeletionNoticeDispatcher } from './account-deletion-notice.dispatcher';
import { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';
import { PatientAccountDeletionService } from './patient-account-deletion.service';
import { RecordAccessAlertDispatcher } from './record-access-alert.dispatcher';
import { WEB_PUSH_DELIVERY_TIMEOUT_MS, WebPushDispatcher } from '../web-push/web-push.dispatcher';
import { webPushConfiguration } from '../web-push/web-push.config';

/**
 * How long shutdown waits for a tick beyond the longest send in flight (an
 * emergency-contact alert's EMERGENCY_CONTACT_ALERT_TIMEOUT_MS or a web
 * push's WEB_PUSH_DELIVERY_TIMEOUT_MS): the database writes around it.
 */
export const PATIENT_LIFECYCLE_SHUTDOWN_GRACE_MS = 5_000;
/** Share invitations past their end closed per tick (0095). */
export const SHARE_INVITATION_EXPIRY_BATCH = 100;
/** Due account deletions completed per tick (0096). */
export const ACCOUNT_DELETION_FINALIZE_BATCH = 10;

/**
 * The patient lifecycle's periodic work, every PATIENT_LIFECYCLE_SWEEP_SECONDS
 * (no timer when 0, or under NODE_ENV=test). Each tick runs, in order, each
 * step in its own try/catch that logs the code only:
 *   1. the emergency-contact alerts, while EMERGENCY_CONTACT_DELIVERY_ENABLED;
 *   2. identity.expire_share_invitations (0095): an invitation's end is the
 *      patient's own deadline, so it runs whatever the sharing switch;
 *   3. the records-opened emails (0095), while RECORD_ACCESS_EMAIL_ENABLED;
 *   4. identity.finalize_due_patient_account_deletions(10) (0096), always: a
 *      scheduled deletion is the patient's decision;
 *   5. the account-deletion emails (0096), always (scheduled, cancelled and
 *      completed);
 *   6. identity.prune_web_push_subscriptions(100) (0097), always, even while
 *      push is off: a subscription whose sign-in has ended is erased;
 *   7. the web pushes due (0097), while Identity's push is on
 *      (web-push.config.ts).
 * The timer no longer depends on the emergency-contact switch. Multiple
 * replicas are safe: claims use row locks with SKIP LOCKED and leases.
 */
@Injectable()
export class PatientLifecycleSweeper implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(PatientLifecycleSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly dispatcher: EmergencyContactNotificationDispatcher,
    @Optional() private readonly database?: DatabaseService,
    @Optional() private readonly recordAccessAlerts?: RecordAccessAlertDispatcher,
    @Optional() private readonly accountDeletion?: PatientAccountDeletionService,
    @Optional() private readonly accountDeletionNotices?: AccountDeletionNoticeDispatcher,
    @Optional() private readonly webPush?: WebPushDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.environment.PATIENT_LIFECYCLE_SWEEP_SECONDS;
    if (seconds === 0) {
      if (this.environment.EMERGENCY_CONTACT_DELIVERY_ENABLED) {
        this.logger.warn('Emergency-contact delivery is enabled but PATIENT_LIFECYCLE_SWEEP_SECONDS is 0; '
          + 'no emergency-access alert will be sent');
      }
      return;
    }
    if (this.environment.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.runOnce(); }, seconds * 1_000);
    this.timer.unref();
  }

  /**
   * Runs before DatabaseService ends the pool (after-response-tasks.ts). Stops
   * the timer and the dispatchers, then waits for the tick in flight, so an
   * email already sent records its outcome instead of being sent again by
   * another task once its lease expires.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopped = true;
    this.dispatcher.stop();
    this.recordAccessAlerts?.stop();
    this.accountDeletionNotices?.stop();
    this.webPush?.stop();
    if (!this.inFlight) return;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(this.environment.EMERGENCY_CONTACT_ALERT_TIMEOUT_MS, WEB_PUSH_DELIVERY_TIMEOUT_MS)
        + PATIENT_LIFECYCLE_SHUTDOWN_GRACE_MS);
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
    if (this.environment.EMERGENCY_CONTACT_DELIVERY_ENABLED) {
      await this.step('emergency_contact_alerts', correlationId, () => this.dispatcher.dispatch(correlationId));
    }
    if (this.database) {
      const database = this.database;
      await this.step('share_invitation_expiry', correlationId, () => database.withSystemTransaction(correlationId,
        (client) => client.query('select identity.expire_share_invitations($1)', [SHARE_INVITATION_EXPIRY_BATCH])));
    }
    if (this.environment.RECORD_ACCESS_EMAIL_ENABLED && this.recordAccessAlerts) {
      const alerts = this.recordAccessAlerts;
      await this.step('record_access_alerts', correlationId, () => alerts.dispatch(correlationId));
    }
    if (this.accountDeletion) {
      const deletion = this.accountDeletion;
      await this.step('account_deletion_finalize', correlationId,
        () => deletion.finalizeDue(correlationId, ACCOUNT_DELETION_FINALIZE_BATCH));
    }
    if (this.accountDeletionNotices) {
      const notices = this.accountDeletionNotices;
      await this.step('account_deletion_notices', correlationId, () => notices.dispatch(correlationId));
    }
    if (this.webPush) {
      const webPush = this.webPush;
      await this.step('web_push_prune', correlationId, () => webPush.prune(correlationId));
      if (webPushConfiguration().on) {
        await this.step('web_push_dispatch', correlationId, () => webPush.dispatch(correlationId));
      }
    }
  }

  private async step(name: string, correlationId: string, work: () => Promise<unknown>): Promise<void> {
    // Once shutdown has begun, the steps not yet started do not start.
    if (this.stopped) return;
    try {
      await work();
    } catch (error) {
      // Never log driver or provider messages: they can contain identifiers.
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
      this.logger.error(`Patient lifecycle sweep failed (step=${name}, code=${code}, correlation=${correlationId})`);
    }
  }
}
