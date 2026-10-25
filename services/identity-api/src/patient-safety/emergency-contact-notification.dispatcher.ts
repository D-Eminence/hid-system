import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { DOMAIN_LIKE } from '../identity/staff-names';
import { EmergencyContactProtector, type EmergencyContactChannel } from './emergency-contact-protector';

/**
 * Each claim leases at most this many notices for this long. The alerts of a
 * batch are sent one after another, each within EMERGENCY_CONTACT_ALERT_TIMEOUT_MS
 * (20 s at most), so a batch finishes before its lease expires and another
 * replica never re-leases and sends an alert twice.
 */
export const EMERGENCY_CONTACT_CLAIM_LIMIT = 5;
export const EMERGENCY_CONTACT_CLAIM_LEASE_SECONDS = 120;
/** Batches per tick; a tick stops early at the first batch that is not full. */
export const EMERGENCY_CONTACT_CLAIM_BATCHES = 5;

interface ClaimedNotification {
  notification_id: string;
  contact_id: string;
  channel: EmergencyContactChannel;
  contact_ciphertext: Buffer;
  contact_key_version: string;
  patient_full_name: string | null;
  /** The last four characters of the Health ID, never the full HID. */
  patient_hid_suffix: string | null;
  clinician_name: string | null;
  facility_name: string | null;
  facility_phone_e164: string | null;
  occurred_at: Date;
  attempt_count: number;
}

// The alert contract (notification-api DeliverEmergencyContactAlertDto) accepts
// a fixed character set and rejects anything else as a definitive failure.
// Names are normalized to that set here so a legitimate name never stops an
// emergency alert from being sent.
function alertText(value: string | null, disallowed: RegExp, leading: RegExp, maxLength: number): string | null {
  const text = (value ?? '').normalize('NFC').replace(/[‘’ʼ]/gu, "'")
    .replace(disallowed, ' ').replace(/ +/gu, ' ').replace(leading, '');
  return Array.from(text).slice(0, maxLength).join('').trim() || null;
}

export function alertPatientFullName(value: string | null): string {
  return alertText(value, /[^\p{L}\p{M}' .-]/gu, /^[^\p{L}\p{M}]+/u, 120) ?? 'Someone';
}

/**
 * The clinician as the alert names them, or null ("a health worker"). A
 * display name is typed by its holder (a self-signed-up administrator or an
 * invitee), so one that still reads like a domain after cleaning
 * ("hid-payroll.com") is dropped: a mail client could make it a link (P4b, V1).
 */
export function alertClinicianName(value: string | null): string | null {
  const name = alertText(value, /[^\p{L}\p{M}' .-]/gu, /^[^\p{L}\p{M}]+/u, 120);
  return name !== null && DOMAIN_LIKE.test(name) ? null : name;
}

export function alertFacilityName(value: string | null): string | null {
  return alertText(value, /[^\p{L}\p{N}\p{M}' .,&()/-]/gu, /^[^\p{L}\p{N}\p{M}]+/u, 120);
}

/** The masked Health ID: four characters of the HID alphabet, or null when it is anything else. */
export function alertHidSuffix(value: string | null): string | null {
  return value !== null && /^[A-HJ-NP-Z2-9]{4}$/.test(value) ? value : null;
}

export function alertPhone(value: string | null): string | null {
  return value !== null && /^\+[1-9][0-9]{7,14}$/.test(value) ? value : null;
}

export interface DispatchSummary {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

/**
 * Delivers emergency-contact notification intents created from the existing
 * `EmergencyAccessActivated` outbox row. Claims are leased; outcomes, retry
 * backoff, exhaustion, and audit are recorded by Identity-owned commands.
 * Delivery is disabled unless EMERGENCY_CONTACT_DELIVERY_ENABLED is true. The
 * alert carries the owner's field set and the fixed reason; the claim never
 * returns the clinician's typed break-glass reason or the full Health ID.
 */
@Injectable()
export class EmergencyContactNotificationDispatcher {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(EmergencyContactNotificationDispatcher.name);
  private readonly workerId = `identity-api:${randomUUID()}`;
  private stopped = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly protector: EmergencyContactProtector,
    private readonly notification: NotificationOtpClient,
  ) {}

  /**
   * At shutdown: claim and send nothing more. An alert already being sent
   * finishes and records its outcome; notices claimed but not started keep
   * their lease and are retried once it expires.
   */
  stop(): void {
    this.stopped = true;
  }

  async dispatch(correlationId: string): Promise<DispatchSummary> {
    const summary: DispatchSummary = { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    if (!this.environment.EMERGENCY_CONTACT_DELIVERY_ENABLED) return summary;
    for (let batch = 0; batch < EMERGENCY_CONTACT_CLAIM_BATCHES; batch += 1) {
      if (this.stopped) break;
      const claimed = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ClaimedNotification>(
        'select * from identity.claim_emergency_contact_notifications($1, $2, $3)',
        [this.workerId, EMERGENCY_CONTACT_CLAIM_LIMIT, EMERGENCY_CONTACT_CLAIM_LEASE_SECONDS],
      )).rows);
      summary.claimed += claimed.length;
      for (const notice of claimed) {
        if (this.stopped) break;
        const delivery = await this.deliver(notice, correlationId);
        const next = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ next_status: string }>(
          'select identity.record_emergency_contact_notification_outcome($1, $2, $3, $4, $5) as next_status',
          [notice.notification_id, this.workerId, delivery.outcome, delivery.provider ?? null, delivery.safeCode ?? null],
        )).rows[0]?.next_status);
        if (next === 'delivered') summary.delivered += 1;
        else if (next === 'pending') summary.retried += 1;
        else if (next === 'failed') summary.failed += 1;
      }
      if (claimed.length < EMERGENCY_CONTACT_CLAIM_LIMIT) break;
    }
    // Counts only: never a recipient, name, identifier or provider message.
    if (summary.claimed > 0) {
      this.logger.log(`Emergency-contact dispatch (event=emergency_contact_dispatch claimed=${summary.claimed} `
        + `delivered=${summary.delivered} retried=${summary.retried} failed=${summary.failed})`);
    }
    return summary;
  }

  private async deliver(notice: ClaimedNotification, correlationId: string)
    : Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    // A channel switched off since the contact was verified cannot be sent on.
    if (!this.environment.EMERGENCY_CONTACT_CHANNELS.includes(notice.channel)) {
      return { outcome: 'definitive_failure', safeCode: 'channel_unavailable' };
    }
    const patientHidSuffix = alertHidSuffix(notice.patient_hid_suffix);
    if (!patientHidSuffix) return { outcome: 'definitive_failure', safeCode: 'patient_identifier_invalid' };
    let recipient: string;
    try {
      recipient = this.protector.decrypt(notice.contact_id, notice.contact_key_version, notice.contact_ciphertext).destination;
    } catch {
      // Missing or rotated key material cannot be retried into success.
      return { outcome: 'definitive_failure', safeCode: 'contact_protection_unavailable' };
    }
    return this.notification.deliverEmergencyContactAlert({
      notificationId: notice.notification_id,
      channel: notice.channel,
      recipient,
      patientFullName: alertPatientFullName(notice.patient_full_name),
      patientHidSuffix,
      clinicianName: alertClinicianName(notice.clinician_name),
      facilityName: alertFacilityName(notice.facility_name),
      facilityPhone: alertPhone(notice.facility_phone_e164),
      occurredAt: notice.occurred_at,
      correlationId,
    });
  }
}
