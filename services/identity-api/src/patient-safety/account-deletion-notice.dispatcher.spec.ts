import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { DatabaseService } from '../database/database.service';
import { fakeDatabase, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';
import {
  ACCOUNT_DELETION_NOTICE_CLAIM_LEASE_SECONDS, ACCOUNT_DELETION_NOTICE_CLAIM_LIMIT, AccountDeletionNoticeDispatcher,
} from './account-deletion-notice.dispatcher';
import type { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';
import type { PatientAccountDeletionService } from './patient-account-deletion.service';
import { ACCOUNT_DELETION_FINALIZE_BATCH, PatientLifecycleSweeper, SHARE_INVITATION_EXPIRY_BATCH } from './patient-lifecycle.sweeper';
import type { RecordAccessAlertDispatcher } from './record-access-alert.dispatcher';

const claimed = (index: number, kind: 'scheduled' | 'cancelled' | 'completed' = 'scheduled') => ({
  notice_id: `n${index}`, request_id: `r${index}`, kind, recipient: 'patient@example.test',
  scheduled_for: kind === 'scheduled' ? new Date('2026-11-11T09:05:00Z') : null, attempt_count: 1 });

function dispatcherWith(deliverAccountDeletionNotice: jest.Mock, claims: unknown[][], outcome = 'delivered') {
  const fake = fakeDatabase();
  fake.query.mockImplementation(async (sql: string) => {
    if (sql.includes('claim_account_deletion_notices')) return { rows: claims.shift() ?? [] };
    if (sql.includes('record_account_deletion_notice_outcome')) return { rows: [{ next_status: outcome }] };
    return { rows: [] };
  });
  const dispatcher = new AccountDeletionNoticeDispatcher(fake.database,
    { deliverAccountDeletionNotice } as unknown as NotificationOtpClient);
  return { ...fake, dispatcher };
}

describe('AccountDeletionNoticeDispatcher (0096)', () => {
  describe('with account deletion on (the default)', () => {
    usePatientSafetyTestEnvironment();

    it('sends the kind and date only to the claimed recipient, keyed by the request, and records the outcome', async () => {
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' });
      const { dispatcher, query } = dispatcherWith(deliver, [[claimed(1), claimed(2, 'completed')]]);
      await expect(dispatcher.dispatch('patient-lifecycle-1')).resolves.toEqual({ claimed: 2, delivered: 2, retried: 0, failed: 0 });
      expect(deliver).toHaveBeenNthCalledWith(1, { requestId: 'r1', recipient: 'patient@example.test', kind: 'scheduled',
        scheduledFor: new Date('2026-11-11T09:05:00Z'), correlationId: 'patient-lifecycle-1' });
      expect(deliver).toHaveBeenNthCalledWith(2, { requestId: 'r2', recipient: 'patient@example.test', kind: 'completed',
        correlationId: 'patient-lifecycle-1' });
      const claim = query.mock.calls.find(([sql]) => String(sql).includes('claim_account_deletion_notices'))!;
      expect(claim[1]).toEqual([expect.stringMatching(/^identity-api:/), ACCOUNT_DELETION_NOTICE_CLAIM_LIMIT,
        ACCOUNT_DELETION_NOTICE_CLAIM_LEASE_SECONDS]);
      const recorded = query.mock.calls.find(([sql]) => String(sql).includes('record_account_deletion_notice_outcome'))!;
      expect(recorded[1]).toEqual(['n1', claim[1][0], 'accepted', 'ses', null]);
    });

    it('records a thrown send as unknown (retried), and claims again only after a full batch', async () => {
      const deliver = jest.fn().mockRejectedValue(new Error('socket'));
      const full = Array.from({ length: ACCOUNT_DELETION_NOTICE_CLAIM_LIMIT }, (_, index) => claimed(index, 'cancelled'));
      const { dispatcher, query } = dispatcherWith(deliver, [full, [claimed(99, 'cancelled')]], 'pending');
      await expect(dispatcher.dispatch('patient-lifecycle-2')).resolves.toMatchObject(
        { claimed: ACCOUNT_DELETION_NOTICE_CLAIM_LIMIT + 1, retried: ACCOUNT_DELETION_NOTICE_CLAIM_LIMIT + 1 });
      expect(query.mock.calls.filter(([sql]) => String(sql).includes('claim_account_deletion_notices'))).toHaveLength(2);
      const recorded = query.mock.calls.find(([sql]) => String(sql).includes('record_account_deletion_notice_outcome'))!;
      expect(recorded[1]).toEqual(expect.arrayContaining(['unknown', 'transport_error']));
    });

    it('claims nothing once stopped', async () => {
      const { dispatcher, query } = dispatcherWith(jest.fn(), [[claimed(1)]]);
      dispatcher.stop();
      await dispatcher.dispatch('patient-lifecycle-3');
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('with ACCOUNT_DELETION_ENABLED=false', () => {
    usePatientSafetyTestEnvironment({ ACCOUNT_DELETION_ENABLED: 'false' });

    it('still sends: a deletion already scheduled completes and the patient is told', async () => {
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted' });
      const { dispatcher } = dispatcherWith(deliver, [[claimed(1, 'completed')]]);
      await expect(dispatcher.dispatch('patient-lifecycle-4')).resolves.toMatchObject({ claimed: 1, delivered: 1 });
    });
  });
});

describe('PatientLifecycleSweeper steps (0096)', () => {
  function sweeperWith(fail: string[] = []) {
    const order: string[] = [];
    const step = (name: string) => jest.fn(async () => { order.push(name); if (fail.includes(name)) throw Object.assign(new Error('Ada'), { code: 'XX000' }); });
    const emergency = { dispatch: step('emergency'), stop: jest.fn() };
    const alerts = { dispatch: step('alerts'), stop: jest.fn() };
    const notices = { dispatch: step('notices'), stop: jest.fn() };
    const deletion = { finalizeDue: jest.fn(async (_correlation: string, limit: number) => {
      order.push(`finalize:${limit}`);
      if (fail.includes('finalize')) throw Object.assign(new Error('Ada'), { code: '40P01' });
      return [];
    }) };
    const fake = fakeDatabase();
    fake.query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes('expire_share_invitations')) order.push(`expire:${String(values[0])}`);
      return { rows: [] };
    });
    const sweeper = new PatientLifecycleSweeper(emergency as unknown as EmergencyContactNotificationDispatcher,
      fake.database as DatabaseService, alerts as unknown as RecordAccessAlertDispatcher,
      deletion as unknown as PatientAccountDeletionService, notices as unknown as AccountDeletionNoticeDispatcher);
    const error = jest.spyOn((sweeper as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    return { sweeper, order, error, notices, deletion };
  }

  describe('with every switch on', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' });

    it('finalizes due deletions and sends their emails after the 0095 steps, each on its own', async () => {
      const { sweeper, order, error } = sweeperWith(['finalize']);
      await sweeper.runOnce();
      expect(order).toEqual(['emergency', `expire:${SHARE_INVITATION_EXPIRY_BATCH}`, 'alerts',
        `finalize:${ACCOUNT_DELETION_FINALIZE_BATCH}`, 'notices']);
      expect(error.mock.calls.map(([message]) => message)).toEqual([
        expect.stringMatching(/step=account_deletion_finalize, code=40P01/)]);
      expect(error.mock.calls.join(' ')).not.toContain('Ada');
    });

    it('stops the deletion emails at shutdown and starts no step after it', async () => {
      const { sweeper, order, notices } = sweeperWith();
      await sweeper.beforeApplicationShutdown();
      await sweeper.runOnce();
      expect(order).toEqual([]);
      expect(notices.stop).toHaveBeenCalled();
    });
  });

  describe('with account deletion, the emergency switch and the records-opened email off', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'false', RECORD_ACCESS_EMAIL_ENABLED: 'false',
      ACCOUNT_DELETION_ENABLED: 'false' });

    it('still finalizes scheduled deletions and sends their emails', async () => {
      const { sweeper, order } = sweeperWith();
      await sweeper.runOnce();
      expect(order).toEqual([`expire:${SHARE_INVITATION_EXPIRY_BATCH}`, `finalize:${ACCOUNT_DELETION_FINALIZE_BATCH}`,
        'notices']);
    });
  });
});
