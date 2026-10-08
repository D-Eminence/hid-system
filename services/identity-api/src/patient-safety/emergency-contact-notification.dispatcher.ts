import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { EmergencyContactProtector, type EmergencyContactChannel } from './emergency-contact-protector';

interface ClaimedNotification {
  notification_id: string;
  contact_id: string;
  channel: EmergencyContactChannel;
  contact_ciphertext: Buffer;
  contact_key_version: string;
  patient_first_name: string;
  facility_name: string | null;
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

export function alertPatientFirstName(value: string | null): string {
  return alertText(value, /[^\p{L}\p{M}' .-]/gu, /^[^\p{L}\p{M}]+/u, 60) ?? 'Someone';
}

export function alertFacilityName(value: string | null): string | null {
  return alertText(value, /[^\p{L}\p{N}\p{M}' .,&()/-]/gu, /^[^\p{L}\p{N}\p{M}]+/u, 120);
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
 * Delivery is disabled unless EMERGENCY_CONTACT_DELIVERY_ENABLED is true, which
 * configuration refuses for production.
 */
@Injectable()
export class EmergencyContactNotificationDispatcher {
  private readonly environment = getEnvironment();
  private readonly workerId = `identity-api:${randomUUID()}`;

  constructor(
    private readonly database: DatabaseService,
    private readonly protector: EmergencyContactProtector,
    private readonly notification: NotificationOtpClient,
  ) {}

  async dispatch(correlationId: string, limit = 10): Promise<DispatchSummary> {
    const summary: DispatchSummary = { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    if (!this.environment.EMERGENCY_CONTACT_DELIVERY_ENABLED) return summary;
    const claimed = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ClaimedNotification>(
      'select * from identity.claim_emergency_contact_notifications($1, $2, $3)', [this.workerId, limit, 60],
    )).rows);
    summary.claimed = claimed.length;
    for (const notice of claimed) {
      const delivery = await this.deliver(notice, correlationId);
      const next = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ next_status: string }>(
        'select identity.record_emergency_contact_notification_outcome($1, $2, $3, $4, $5) as next_status',
        [notice.notification_id, this.workerId, delivery.outcome, delivery.provider ?? null, delivery.safeCode ?? null],
      )).rows[0]?.next_status);
      if (next === 'delivered') summary.delivered += 1;
      else if (next === 'pending') summary.retried += 1;
      else if (next === 'failed') summary.failed += 1;
    }
    return summary;
  }

  private async deliver(notice: ClaimedNotification, correlationId: string)
    : Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
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
      patientFirstName: alertPatientFirstName(notice.patient_first_name),
      facilityName: alertFacilityName(notice.facility_name),
      occurredAt: notice.occurred_at,
      correlationId,
    });
  }
}
