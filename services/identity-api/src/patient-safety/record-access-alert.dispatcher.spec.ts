import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { DatabaseService } from '../database/database.service';
import { fakeDatabase, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';
import type { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';
import { PatientLifecycleSweeper, SHARE_INVITATION_EXPIRY_BATCH } from './patient-lifecycle.sweeper';
import {
  RECORD_ACCESS_ALERT_CLAIM_LEASE_SECONDS, RECORD_ACCESS_ALERT_CLAIM_LIMIT, RecordAccessAlertDispatcher,
} from './record-access-alert.dispatcher';

const claimed = (index: number) => ({ notice_id: `n${index}`, recipient: 'patient@example.test',
  occurred_at: new Date('2026-10-28T09:05:00Z'), attempt_count: 1 });

function dispatcherWith(deliverRecordAccessAlert: jest.Mock, claims: unknown[][], outcome = 'delivered') {
  const fake = fakeDatabase();
  fake.query.mockImplementation(async (sql: string) => {
    if (sql.includes('claim_record_access_alerts')) return { rows: claims.shift() ?? [] };
    if (sql.includes('record_record_access_alert_outcome')) return { rows: [{ next_status: outcome }] };
    return { rows: [] };
  });
  const dispatcher = new RecordAccessAlertDispatcher(fake.database,
    { deliverRecordAccessAlert } as unknown as NotificationOtpClient);
  return { ...fake, dispatcher };
}

describe('RecordAccessAlertDispatcher (0095)', () => {
  describe('with the email on (the default)', () => {
    usePatientSafetyTestEnvironment();

    it('sends the time only to the claimed recipient, keyed by the notice, and records the outcome under its lease', async () => {
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' });
      const { dispatcher, query } = dispatcherWith(deliver, [[claimed(1)]]);
      await expect(dispatcher.dispatch('patient-lifecycle-1')).resolves.toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
      expect(deliver).toHaveBeenCalledWith({ noticeId: 'n1', recipient: 'patient@example.test',
        occurredAt: new Date('2026-10-28T09:05:00Z'), correlationId: 'patient-lifecycle-1' });
      const claim = query.mock.calls.find(([sql]) => String(sql).includes('claim_record_access_alerts'))!;
      expect(claim[1]).toEqual([expect.stringMatching(/^identity-api:/), RECORD_ACCESS_ALERT_CLAIM_LIMIT,
        RECORD_ACCESS_ALERT_CLAIM_LEASE_SECONDS]);
      const recorded = query.mock.calls.find(([sql]) => String(sql).includes('record_record_access_alert_outcome'))!;
      expect(recorded[1]).toEqual(['n1', claim[1][0], 'accepted', 'ses', null]);
    });

    it('records a thrown send as unknown (retried), and claims again only after a full batch', async () => {
      const deliver = jest.fn().mockRejectedValue(new Error('socket'));
      const full = Array.from({ length: RECORD_ACCESS_ALERT_CLAIM_LIMIT }, (_, index) => claimed(index));
      const { dispatcher, query } = dispatcherWith(deliver, [full, [claimed(99)]], 'pending');
      await expect(dispatcher.dispatch('patient-lifecycle-2')).resolves.toMatchObject(
        { claimed: RECORD_ACCESS_ALERT_CLAIM_LIMIT + 1, retried: RECORD_ACCESS_ALERT_CLAIM_LIMIT + 1 });
      expect(query.mock.calls.filter(([sql]) => String(sql).includes('claim_record_access_alerts'))).toHaveLength(2);
      const recorded = query.mock.calls.find(([sql]) => String(sql).includes('record_record_access_alert_outcome'))!;
      expect(recorded[1]).toEqual(expect.arrayContaining(['unknown', 'transport_error']));
    });

    it('claims nothing once stopped', async () => {
      const { dispatcher, query } = dispatcherWith(jest.fn(), [[claimed(1)]]);
      dispatcher.stop();
      await dispatcher.dispatch('patient-lifecycle-3');
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('with RECORD_ACCESS_EMAIL_ENABLED=false', () => {
    usePatientSafetyTestEnvironment({ RECORD_ACCESS_EMAIL_ENABLED: 'false' });

    it('claims and sends nothing', async () => {
      const deliver = jest.fn();
      const { dispatcher, withSystemTransaction } = dispatcherWith(deliver, [[claimed(1)]]);
      await expect(dispatcher.dispatch('patient-lifecycle-4')).resolves.toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
      expect(withSystemTransaction).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});

describe('PatientLifecycleSweeper steps (0095)', () => {
  function sweeperWith(fail: string[] = []) {
    const order: string[] = [];
    const step = (name: string) => jest.fn(async () => { order.push(name); if (fail.includes(name)) throw Object.assign(new Error('Ada'), { code: 'XX000' }); });
    const emergency = { dispatch: step('emergency'), stop: jest.fn() };
    const alerts = { dispatch: step('alerts'), stop: jest.fn() };
    const fake = fakeDatabase();
    fake.query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes('expire_share_invitations')) {
        order.push(`expire:${String(values[0])}`);
        if (fail.includes('expire')) throw Object.assign(new Error('Ada'), { code: '42883' });
      }
      return { rows: [] };
    });
    const sweeper = new PatientLifecycleSweeper(emergency as unknown as EmergencyContactNotificationDispatcher,
      fake.database as DatabaseService, alerts as unknown as RecordAccessAlertDispatcher);
    const error = jest.spyOn((sweeper as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    return { sweeper, order, error, emergency, alerts };
  }

  describe('with every switch on', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' });

    it('runs the steps in order, each on its own: a failure logs its step and code only', async () => {
      const { sweeper, order, error } = sweeperWith(['emergency', 'expire']);
      await sweeper.runOnce();
      expect(order).toEqual(['emergency', `expire:${SHARE_INVITATION_EXPIRY_BATCH}`, 'alerts']);
      expect(error.mock.calls.map(([message]) => message)).toEqual([
        expect.stringMatching(/step=emergency_contact_alerts, code=XX000/),
        expect.stringMatching(/step=share_invitation_expiry, code=42883/)]);
      expect(error.mock.calls.join(' ')).not.toContain('Ada');
    });

    it('starts no step once shutdown has begun', async () => {
      const { sweeper, order, emergency, alerts } = sweeperWith();
      await sweeper.beforeApplicationShutdown();
      await sweeper.runOnce();
      expect(order).toEqual([]);
      expect(emergency.stop).toHaveBeenCalled();
      expect(alerts.stop).toHaveBeenCalled();
    });
  });

  describe('with emergency-contact delivery and the records-opened email off', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'false', RECORD_ACCESS_EMAIL_ENABLED: 'false' });

    it('still expires share invitations: the sweep is no longer tied to the emergency switch', async () => {
      const { sweeper, order } = sweeperWith();
      await sweeper.runOnce();
      expect(order).toEqual([`expire:${SHARE_INVITATION_EXPIRY_BATCH}`]);
    });
  });
});
