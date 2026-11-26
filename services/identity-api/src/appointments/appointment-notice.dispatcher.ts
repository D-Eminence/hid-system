import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { CollectedFieldProtector, registrationCaseContactLabel } from '../identity/collected-field-protector';
import { PATIENT_PHONE_E164 } from '../identity/contact-lookup';

/** Each claim leases at most this many rows; one send takes at most 5 s (the client's timeout). */
export const APPOINTMENT_EMAIL_CLAIM_LIMIT = 10;
export const APPOINTMENT_EMAIL_CLAIM_LEASE_SECONDS = 120;
export const APPOINTMENT_SMS_CLAIM_LIMIT = 10;
/** Batches per tick; a tick stops early at the first batch that is not full. */
export const APPOINTMENT_NOTICE_CLAIM_BATCHES = 5;

const NOTICE_KINDS = {
  APPOINTMENT_BOOKED: 'booked',
  APPOINTMENT_RESCHEDULED: 'rescheduled',
  APPOINTMENT_CANCELLED: 'cancelled',
  APPOINTMENT_REMINDER: 'reminder',
} as const;

interface ClaimedEmail {
  email_id: string;
  recipient: string;
  notice_code: keyof typeof NOTICE_KINDS;
  attempt_count: number;
}

interface ClaimedSms {
  sms_id: string;
  facility_name: string;
  starts_at: Date;
  registration_case_id: string;
  phone_ciphertext: Buffer;
  key_version: string;
}

export interface AppointmentNoticeSummary {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

/** The email record's outcome for a delivery answer. */
export function emailOutcome(outcome: OtpDeliveryOutcome): 'delivered' | 'retry' | 'failed' {
  return outcome === 'accepted' ? 'delivered' : outcome === 'definitive_failure' ? 'failed' : 'retry';
}

/** A safe code as 0161's email record takes it (lower case) or its SMS record (upper case). */
export function safeCode(code: string | undefined, upper: boolean): string | null {
  if (!code) return null;
  const cleaned = code.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 79);
  if (!/^[a-z]/.test(cleaned)) return upper ? 'DELIVERY_ERROR' : 'delivery_error';
  return upper ? cleaned.toUpperCase() : cleaned;
}

/**
 * APPT-1 (0161, Q-APPT-3 A): sends the appointment emails and, only while the
 * Platform control appointment_sms_reminders_enabled is on (seeded off), the
 * reminder SMS that 0161 queued, as the system actor, under leases (SKIP
 * LOCKED) held by this worker. The email is generic and goes only to a
 * verified email (0063's rule, checked again at the claim); the SMS goes only
 * to the phone the facility recorded, decrypted here, between 07:00 and 21:00
 * Lagos (the database leases none outside). Nothing is claimed while
 * APPOINTMENTS_ENABLED is off. Logs counts only.
 */
@Injectable()
export class AppointmentNoticeDispatcher {
  private readonly logger = new Logger(AppointmentNoticeDispatcher.name);
  private readonly workerId = `identity-api:${randomUUID()}`;
  private readonly protector: CollectedFieldProtector;
  private stopped = false;

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient,
    @Optional() protector?: CollectedFieldProtector) {
    this.protector = protector ?? new CollectedFieldProtector();
  }

  /** At shutdown: claim and send nothing more; a claimed row comes back once its lease expires. */
  stop(): void {
    this.stopped = true;
  }

  async dispatchEmails(correlationId: string): Promise<AppointmentNoticeSummary> {
    const summary: AppointmentNoticeSummary = { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    if (!getEnvironment().APPOINTMENTS_ENABLED) return summary;
    for (let batch = 0; batch < APPOINTMENT_NOTICE_CLAIM_BATCHES; batch += 1) {
      if (this.stopped) break;
      const claimed = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ClaimedEmail>(
        'select email_id::text, recipient, notice_code, attempt_count from identity.appointment_email_claim($1, $2, $3)',
        [this.workerId, APPOINTMENT_EMAIL_CLAIM_LIMIT, APPOINTMENT_EMAIL_CLAIM_LEASE_SECONDS])).rows);
      summary.claimed += claimed.length;
      for (const email of claimed) {
        if (this.stopped) break;
        const delivery = await this.notification.deliverAppointmentEmail({ emailId: email.email_id,
          recipient: email.recipient, kind: NOTICE_KINDS[email.notice_code] ?? 'booked', correlationId })
          .catch(() => ({ outcome: 'unknown' as const, safeCode: 'transport_error' }));
        const next = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ next: string }>(
          'select identity.appointment_email_record($1, $2, $3, $4) as next',
          [email.email_id, this.workerId, emailOutcome(delivery.outcome), safeCode(delivery.safeCode, false)])).rows[0]?.next);
        if (next === 'delivered') summary.delivered += 1;
        else if (next === 'pending') summary.retried += 1;
        else if (next === 'failed') summary.failed += 1;
      }
      if (claimed.length < APPOINTMENT_EMAIL_CLAIM_LIMIT) break;
    }
    this.log('email', summary);
    return summary;
  }

  async dispatchSms(correlationId: string): Promise<AppointmentNoticeSummary> {
    const summary: AppointmentNoticeSummary = { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    if (!getEnvironment().APPOINTMENTS_ENABLED) return summary;
    for (let batch = 0; batch < APPOINTMENT_NOTICE_CLAIM_BATCHES; batch += 1) {
      if (this.stopped) break;
      // The database answers nothing while the Platform control is off (or unreadable), and nothing outside
      // 07:00-21:00 Lagos; it leases only rows it can answer, each to this worker.
      const claimed = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ClaimedSms>(
        `select sms_id::text, facility_name, starts_at, registration_case_id::text, phone_ciphertext, key_version
           from identity.appointment_sms_claim($1, $2)`, [this.workerId, APPOINTMENT_SMS_CLAIM_LIMIT])).rows);
      summary.claimed += claimed.length;
      for (const sms of claimed) {
        if (this.stopped) break;
        const phone = this.phone(sms);
        const delivery = phone === null
          ? { outcome: 'definitive_failure' as const, safeCode: 'phone_unreadable' }
          : await this.notification.deliverAppointmentReminderSms({ smsId: sms.sms_id, recipient: phone,
            facilityName: sms.facility_name, startsAt: new Date(sms.starts_at), correlationId })
            .catch(() => ({ outcome: 'unknown' as const, safeCode: 'transport_error' }));
        const outcome = delivery.outcome === 'accepted' ? 'sent' : delivery.outcome === 'definitive_failure' ? 'failed' : 'retry';
        // Only this worker's lease is recorded; a lease that lapsed and went elsewhere answers stale.
        const next = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ next: string }>(
          'select identity.appointment_sms_record($1, $2, $3, $4) as next',
          [sms.sms_id, this.workerId, outcome, safeCode(delivery.safeCode, true)])).rows[0]?.next);
        if (next === 'sent') summary.delivered += 1;
        else if (next === 'pending') summary.retried += 1;
        else if (next === 'failed') summary.failed += 1;
      }
      if (claimed.length < APPOINTMENT_SMS_CLAIM_LIMIT) break;
    }
    this.log('sms', summary);
    return summary;
  }

  private phone(sms: ClaimedSms): string | null {
    try {
      const phone = this.protector.decrypt(registrationCaseContactLabel(sms.registration_case_id, 'phone'), sms.key_version,
        sms.phone_ciphertext);
      return PATIENT_PHONE_E164.test(phone) ? phone : null;
    } catch {
      return null;
    }
  }

  private log(channel: 'email' | 'sms', summary: AppointmentNoticeSummary): void {
    if (summary.claimed === 0) return;
    this.logger.log(`Appointment ${channel} dispatch (event=appointment_${channel}_dispatch claimed=${summary.claimed} `
      + `delivered=${summary.delivered} retried=${summary.retried} failed=${summary.failed})`);
  }
}
