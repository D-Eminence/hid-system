import type { NotificationOtpClient } from '../auth/notification-otp.client';
import { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';
import { EmergencyContactProtector } from './emergency-contact-protector';
import { PatientLifecycleSweeper } from './patient-lifecycle.sweeper';
import type { PatientAccountDeletionService } from './patient-account-deletion.service';
import { fakeDatabase, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';

const contactId = 'a0000000-0000-4000-8000-000000000001';
const notificationId = 'c0000000-0000-4000-8000-000000000001';

describe('EmergencyContactNotificationDispatcher', () => {
  describe('with delivery disabled (default and production)', () => {
    usePatientSafetyTestEnvironment();

    it('claims nothing and sends nothing', async () => {
      const { query, withSystemTransaction, database } = fakeDatabase();
      const deliverEmergencyContactAlert = jest.fn();
      const dispatcher = new EmergencyContactNotificationDispatcher(database, new EmergencyContactProtector(),
        { deliverEmergencyContactAlert } as unknown as NotificationOtpClient);
      await expect(dispatcher.dispatch('patient-lifecycle-test-1')).resolves.toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
      expect(withSystemTransaction).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(deliverEmergencyContactAlert).not.toHaveBeenCalled();
    });
  });

  describe('with staging delivery enabled', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', HID_DEPLOYMENT_ENV: 'staging' });

    function claimed(protector: EmergencyContactProtector, overrides: Record<string, unknown> = {}) {
      return {
        notification_id: notificationId, contact_id: contactId, channel: 'sms',
        contact_ciphertext: protector.encrypt(contactId, { name: 'Chidi', destination: '+2348031234567' }),
        contact_key_version: 'test-v1', patient_first_name: 'Ada', facility_name: 'Lagos General',
        occurred_at: new Date('2026-10-08T09:15:00Z'), attempt_count: 1, ...overrides,
      };
    }

    it('delivers only minimum-necessary fields and records the provider outcome under its lease', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliverEmergencyContactAlert = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'termii' });
      const dispatcher = new EmergencyContactNotificationDispatcher(database, protector,
        { deliverEmergencyContactAlert } as unknown as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [claimed(protector)] }).mockResolvedValueOnce({ rows: [{ next_status: 'delivered' }] });
      await expect(dispatcher.dispatch('patient-lifecycle-test-2')).resolves.toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
      const sent = deliverEmergencyContactAlert.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(sent).sort()).toEqual(
        ['channel', 'correlationId', 'facilityName', 'notificationId', 'occurredAt', 'patientFirstName', 'recipient']);
      expect(sent).toMatchObject({ recipient: '+2348031234567', patientFirstName: 'Ada', facilityName: 'Lagos General' });
      const [claimSql, claimParameters] = query.mock.calls[0] as [string, unknown[]];
      expect(claimSql).toContain('claim_emergency_contact_notifications');
      const [, outcomeParameters] = query.mock.calls[1] as [string, unknown[]];
      expect(outcomeParameters).toEqual([notificationId, claimParameters[0], 'accepted', 'termii', null]);
    });

    it('schedules a retry for an unknown outcome and records protection failures as definitive', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliverEmergencyContactAlert = jest.fn().mockResolvedValue({ outcome: 'unknown', safeCode: 'http_503' });
      const dispatcher = new EmergencyContactNotificationDispatcher(database, protector,
        { deliverEmergencyContactAlert } as unknown as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [
        claimed(protector),
        claimed(protector, { notification_id: 'c0000000-0000-4000-8000-000000000002', contact_key_version: 'rotated' }),
      ] }).mockResolvedValueOnce({ rows: [{ next_status: 'pending' }] }).mockResolvedValueOnce({ rows: [{ next_status: 'failed' }] });
      await expect(dispatcher.dispatch('patient-lifecycle-test-3')).resolves.toEqual({ claimed: 2, delivered: 0, retried: 1, failed: 1 });
      expect(deliverEmergencyContactAlert).toHaveBeenCalledTimes(1);
      expect((query.mock.calls[1] as [string, unknown[]])[1]).toEqual(
        expect.arrayContaining([notificationId, 'unknown', 'http_503']));
      expect((query.mock.calls[2] as [string, unknown[]])[1]).toEqual(
        expect.arrayContaining(['c0000000-0000-4000-8000-000000000002', 'definitive_failure', 'contact_protection_unavailable']));
    });
  });
});

describe('PatientLifecycleSweeper', () => {
  usePatientSafetyTestEnvironment();

  it('finalizes due deletions before dispatching and never overlaps runs', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deletion = { finalizeDue: jest.fn(async () => { order.push('finalize'); await gate; return []; }) };
    const dispatcher = { dispatch: jest.fn(async () => { order.push('dispatch'); return { claimed: 0, delivered: 0, retried: 0, failed: 0 }; }) };
    const sweeper = new PatientLifecycleSweeper(deletion as unknown as PatientAccountDeletionService,
      dispatcher as unknown as EmergencyContactNotificationDispatcher);
    const first = sweeper.runOnce();
    await sweeper.runOnce();
    release();
    await first;
    expect(order).toEqual(['finalize', 'dispatch']);
    expect(deletion.finalizeDue).toHaveBeenCalledWith(expect.stringMatching(/^patient-lifecycle-[0-9a-f-]{36}$/));
  });

  it('contains failures without rethrowing driver messages', async () => {
    const deletion = { finalizeDue: jest.fn().mockRejectedValue(Object.assign(new Error('relation contains PHI'), { code: '57014' })) };
    const dispatcher = { dispatch: jest.fn() };
    const sweeper = new PatientLifecycleSweeper(deletion as unknown as PatientAccountDeletionService,
      dispatcher as unknown as EmergencyContactNotificationDispatcher);
    const error = jest.spyOn((sweeper as unknown as { logger: { error: (message: string) => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    await expect(sweeper.runOnce()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('code=57014'));
    expect(error.mock.calls[0]?.[0]).not.toContain('PHI');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});
