// Only the shutdown spec builds a real DatabaseService; its pool is a fake.
jest.mock('pg', () => ({ Pool: jest.fn() }));
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import { DatabaseModule } from '../database/database.module';
import {
  EMERGENCY_CONTACT_CLAIM_BATCHES, EMERGENCY_CONTACT_CLAIM_LEASE_SECONDS, EMERGENCY_CONTACT_CLAIM_LIMIT,
  EmergencyContactNotificationDispatcher,
} from './emergency-contact-notification.dispatcher';
import { EmergencyContactProtector } from './emergency-contact-protector';
import { PATIENT_LIFECYCLE_SHUTDOWN_GRACE_MS, PatientLifecycleSweeper } from './patient-lifecycle.sweeper';
import { fakeDatabase, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';

const contactId = 'a0000000-0000-4000-8000-000000000001';
const notificationId = 'c0000000-0000-4000-8000-000000000001';

// The exact patterns notification-api's DeliverEmergencyContactAlertDto enforces.
const fullNamePattern = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,119}$/u;
const facilityPattern = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}' .,&()/-]{0,119}$/u;
const hidSuffixPattern = /^[A-HJ-NP-Z2-9]{4}$/;

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function claimed(protector: EmergencyContactProtector, overrides: Record<string, unknown> = {}) {
  return {
    notification_id: notificationId, contact_id: contactId, channel: 'email',
    contact_ciphertext: protector.encrypt(contactId, { name: 'Chidi', destination: 'chidi@example.test' }),
    contact_key_version: 'test-v1', patient_full_name: 'Amina Okafor', patient_hid_suffix: 'EF23',
    clinician_name: 'Dr Bola Adeyemi', facility_name: 'Lagos General', facility_phone_e164: '+2348030000000',
    occurred_at: new Date('2026-10-23T13:35:00Z'), attempt_count: 1, ...overrides,
  };
}

function dispatcherWith(deliverEmergencyContactAlert: jest.Mock) {
  const fake = fakeDatabase();
  const protector = new EmergencyContactProtector();
  const dispatcher = new EmergencyContactNotificationDispatcher(fake.database, protector,
    { deliverEmergencyContactAlert } as unknown as NotificationOtpClient);
  const claims = () => fake.query.mock.calls.filter(([sql]) => String(sql).includes('claim_emergency_contact_notifications'));
  return { ...fake, protector, dispatcher, claims };
}

describe('EmergencyContactNotificationDispatcher', () => {
  describe('with delivery disabled (switched off, also in production)', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'false' });

    it('claims nothing and sends nothing', async () => {
      const deliverEmergencyContactAlert = jest.fn();
      const { query, withSystemTransaction, dispatcher } = dispatcherWith(deliverEmergencyContactAlert);
      await expect(dispatcher.dispatch('patient-lifecycle-test-1')).resolves.toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
      expect(withSystemTransaction).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(deliverEmergencyContactAlert).not.toHaveBeenCalled();
    });
  });

  describe('with delivery enabled', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' });

    it('delivers only the alert fields and records the provider outcome under its lease', async () => {
      const deliverEmergencyContactAlert = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
      const { query, protector, dispatcher } = dispatcherWith(deliverEmergencyContactAlert);
      query.mockResolvedValueOnce({ rows: [claimed(protector)] }).mockResolvedValueOnce({ rows: [{ next_status: 'delivered' }] });
      await expect(dispatcher.dispatch('patient-lifecycle-test-2')).resolves.toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
      const sent = deliverEmergencyContactAlert.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(sent).sort()).toEqual(['channel', 'clinicianName', 'correlationId', 'facilityName', 'facilityPhone',
        'notificationId', 'occurredAt', 'patientFullName', 'patientHidSuffix', 'recipient']);
      expect(sent).toEqual({ notificationId, channel: 'email', recipient: 'chidi@example.test',
        patientFullName: 'Amina Okafor', patientHidSuffix: 'EF23', clinicianName: 'Dr Bola Adeyemi',
        facilityName: 'Lagos General', facilityPhone: '+2348030000000', occurredAt: new Date('2026-10-23T13:35:00Z'),
        correlationId: 'patient-lifecycle-test-2' });
      const [claimSql, claimParameters] = query.mock.calls[0] as [string, unknown[]];
      expect(claimSql).toContain('claim_emergency_contact_notifications');
      expect(claimParameters.slice(1)).toEqual([5, 120]);
      const [, outcomeParameters] = query.mock.calls[1] as [string, unknown[]];
      expect(outcomeParameters).toEqual([notificationId, claimParameters[0], 'accepted', 'brevo', null]);
    });

    it('normalizes names to the alert contract instead of failing the alert', async () => {
      const deliverEmergencyContactAlert = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
      const { query, protector, dispatcher } = dispatcherWith(deliverEmergencyContactAlert);
      query.mockResolvedValueOnce({ rows: [
        claimed(protector, { patient_full_name: 'Ọlá’ Adé #1', clinician_name: 'Dr. Ụ́chè (ICU)',
          facility_name: '#1 St. Mary’s: Ward+ICU_2' }),
        claimed(protector, { notification_id: 'c0000000-0000-4000-8000-000000000003',
          patient_full_name: '###', clinician_name: '***', facility_name: '***', facility_phone_e164: null }),
        claimed(protector, { notification_id: 'c0000000-0000-4000-8000-000000000004',
          patient_full_name: 'A'.repeat(150), clinician_name: null, facility_name: null, facility_phone_e164: '0803 000 0000' }),
      ] }).mockResolvedValue({ rows: [{ next_status: 'delivered' }] });
      await expect(dispatcher.dispatch('patient-lifecycle-test-4')).resolves.toEqual({ claimed: 3, delivered: 3, retried: 0, failed: 0 });
      const sent = deliverEmergencyContactAlert.mock.calls.map(([input]) => input as Record<string, string | null>);
      expect(sent.map(({ patientFullName, clinicianName, facilityName, facilityPhone }) =>
        [patientFullName, clinicianName, facilityName, facilityPhone])).toEqual([
        ['Ọlá\' Adé', 'Dr. Ụ́chè ICU', '1 St. Mary\'s Ward ICU 2', '+2348030000000'],
        ['Someone', null, null, null],
        ['A'.repeat(120), null, null, null],
      ]);
      for (const { patientFullName, clinicianName, facilityName, patientHidSuffix } of sent) {
        expect(patientFullName).toMatch(fullNamePattern);
        expect(patientHidSuffix).toMatch(hidSuffixPattern);
        if (clinicianName !== null) expect(clinicianName).toMatch(fullNamePattern);
        if (facilityName !== null) expect(facilityName).toMatch(facilityPattern);
      }
    });

    it.each([null, 'HID-ABCDEF23', 'ef23', 'EF2', 'EF1O'])(
      'closes an alert whose masked Health ID is %p as a definitive failure, without sending it', async (suffix) => {
        const deliverEmergencyContactAlert = jest.fn();
        const { query, protector, dispatcher } = dispatcherWith(deliverEmergencyContactAlert);
        query.mockResolvedValueOnce({ rows: [claimed(protector, { patient_hid_suffix: suffix })] })
          .mockResolvedValueOnce({ rows: [{ next_status: 'failed' }] });
        await expect(dispatcher.dispatch('patient-lifecycle-test-5')).resolves.toEqual({ claimed: 1, delivered: 0, retried: 0, failed: 1 });
        expect(deliverEmergencyContactAlert).not.toHaveBeenCalled();
        expect((query.mock.calls[1] as [string, unknown[]])[1]).toEqual(
          expect.arrayContaining([notificationId, 'definitive_failure', 'patient_identifier_invalid']));
      });

    it('closes an alert to a contact whose channel is not enabled, without sending it', async () => {
      const deliverEmergencyContactAlert = jest.fn();
      const { query, protector, dispatcher } = dispatcherWith(deliverEmergencyContactAlert);
      query.mockResolvedValueOnce({ rows: [claimed(protector, { channel: 'sms' })] })
        .mockResolvedValueOnce({ rows: [{ next_status: 'failed' }] });
      await dispatcher.dispatch('patient-lifecycle-test-6');
      expect(deliverEmergencyContactAlert).not.toHaveBeenCalled();
      expect((query.mock.calls[1] as [string, unknown[]])[1]).toEqual(
        expect.arrayContaining([notificationId, 'definitive_failure', 'channel_unavailable']));
    });

    it('schedules a retry for an unknown outcome and records protection failures as definitive', async () => {
      const deliverEmergencyContactAlert = jest.fn().mockResolvedValue({ outcome: 'unknown', safeCode: 'http_503' });
      const { query, protector, dispatcher } = dispatcherWith(deliverEmergencyContactAlert);
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

    it('claims another batch while batches come back full, and stops at the first short one', async () => {
      const deliverEmergencyContactAlert = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
      const { query, protector, dispatcher, claims } = dispatcherWith(deliverEmergencyContactAlert);
      const batch = (size: number, start: number) => Array.from({ length: size }, (_, index) => claimed(protector,
        { notification_id: `c0000000-0000-4000-8000-${String(start + index).padStart(12, '0')}` }));
      let claimNumber = 0;
      query.mockImplementation(async (sql: string) => {
        if (!sql.includes('claim_emergency_contact_notifications')) return { rows: [{ next_status: 'delivered' }] };
        claimNumber += 1;
        return { rows: claimNumber <= 2 ? batch(EMERGENCY_CONTACT_CLAIM_LIMIT, claimNumber * 10) : batch(2, 90) };
      });
      await expect(dispatcher.dispatch('patient-lifecycle-test-7')).resolves.toEqual({ claimed: 12, delivered: 12, retried: 0, failed: 0 });
      expect(claims()).toHaveLength(3);
    });

    it('claims at most five batches in one tick', async () => {
      const deliverEmergencyContactAlert = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
      const { query, protector, dispatcher, claims } = dispatcherWith(deliverEmergencyContactAlert);
      query.mockImplementation(async (sql: string) => sql.includes('claim_emergency_contact_notifications')
        ? { rows: Array.from({ length: EMERGENCY_CONTACT_CLAIM_LIMIT }, () => claimed(protector)) }
        : { rows: [{ next_status: 'delivered' }] });
      await expect(dispatcher.dispatch('patient-lifecycle-test-8')).resolves.toMatchObject({ claimed: 25, delivered: 25 });
      expect(claims()).toHaveLength(EMERGENCY_CONTACT_CLAIM_BATCHES);
    });

    it('claims and sends nothing once stopped', async () => {
      const deliverEmergencyContactAlert = jest.fn();
      const { query, dispatcher } = dispatcherWith(deliverEmergencyContactAlert);
      dispatcher.stop();
      await expect(dispatcher.dispatch('patient-lifecycle-test-11')).resolves.toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
      expect(query).not.toHaveBeenCalled();
      expect(deliverEmergencyContactAlert).not.toHaveBeenCalled();
    });

    it('logs one summary line with counts only', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        const deliverEmergencyContactAlert = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
        const { query, protector, dispatcher } = dispatcherWith(deliverEmergencyContactAlert);
        query.mockResolvedValueOnce({ rows: [claimed(protector)] }).mockResolvedValueOnce({ rows: [{ next_status: 'delivered' }] })
          .mockResolvedValue({ rows: [] });
        await dispatcher.dispatch('patient-lifecycle-test-9');
        expect(log).toHaveBeenCalledTimes(1);
        const line = String(log.mock.calls[0]?.[0]);
        expect(line).toContain('event=emergency_contact_dispatch claimed=1 delivered=1 retried=0 failed=0');
        for (const value of ['chidi@example.test', 'Chidi', 'Amina', 'Okafor', 'EF23', 'Bola', 'Lagos', '+234', notificationId,
          contactId]) {
          expect(line).not.toContain(value);
        }
        await dispatcher.dispatch('patient-lifecycle-test-10');
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    });
  });

  describe('lease and alert timeout (a batch must finish before its lease expires)', () => {
    const original = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
      resetEnvironmentForTests();
    });
    const configure = (timeout?: string) => {
      Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
        CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
        AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456' });
      if (timeout === undefined) delete process.env.EMERGENCY_CONTACT_ALERT_TIMEOUT_MS;
      else process.env.EMERGENCY_CONTACT_ALERT_TIMEOUT_MS = timeout;
      resetEnvironmentForTests();
    };

    it.each([undefined, '20000'])('keeps a full batch of alerts within the lease at timeout %p', (timeout) => {
      configure(timeout);
      const alertTimeoutMs = getEnvironment().EMERGENCY_CONTACT_ALERT_TIMEOUT_MS;
      expect(alertTimeoutMs).toBe(timeout === undefined ? 12_000 : 20_000);
      expect(EMERGENCY_CONTACT_CLAIM_LIMIT * alertTimeoutMs).toBeLessThan(EMERGENCY_CONTACT_CLAIM_LEASE_SECONDS * 1_000);
    });

    it.each(['20001', '30000', '999'])('refuses an alert timeout of %s ms', (timeout) => {
      configure(timeout);
      expect(() => getEnvironment()).toThrow(/EMERGENCY_CONTACT_ALERT_TIMEOUT_MS/);
    });
  });
});

describe('PatientLifecycleSweeper', () => {
  // The sweeper never starts a timer under NODE_ENV=test.
  const outsideTests = { NODE_ENV: 'development',
    NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: 'test-service-token-with-32-characters' };
  describe('with delivery enabled', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' });

    it('dispatches and never overlaps runs', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const dispatcher = { dispatch: jest.fn(async () => { await gate; return { claimed: 0, delivered: 0, retried: 0, failed: 0 }; }) };
      const sweeper = new PatientLifecycleSweeper(dispatcher as unknown as EmergencyContactNotificationDispatcher);
      const first = sweeper.runOnce();
      const second = sweeper.runOnce();
      expect(second).toBe(first);
      release();
      await second;
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.stringMatching(/^patient-lifecycle-[0-9a-f-]{36}$/));
      await sweeper.runOnce();
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    });

    it('contains failures without rethrowing driver messages', async () => {
      const dispatcher = { dispatch: jest.fn().mockRejectedValue(Object.assign(new Error('relation contains PHI'), { code: '57014' })) };
      const sweeper = new PatientLifecycleSweeper(dispatcher as unknown as EmergencyContactNotificationDispatcher);
      const error = jest.spyOn((sweeper as unknown as { logger: { error: (message: string) => void } }).logger, 'error')
        .mockImplementation(() => undefined);
      await expect(sweeper.runOnce()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('code=57014'));
      expect(error.mock.calls[0]?.[0]).not.toContain('PHI');
    });

    it('lets the alert in flight record its outcome before the pool ends at app shutdown, and claims or sends nothing more',
      async () => {
        // The real DatabaseService over a fake pool that, like pg-pool, refuses to connect once ended.
        const events: string[] = [];
        let ended = false;
        const protector = new EmergencyContactProtector();
        const query = jest.fn(async (sql: string) => {
          if (sql.includes('claim_emergency_contact_notifications')) {
            events.push('claim');
            // A full batch: without the stop the tick would send the next notice and claim again.
            return { rows: Array.from({ length: EMERGENCY_CONTACT_CLAIM_LIMIT }, (_, index) => claimed(protector,
              { notification_id: `c0000000-0000-4000-8000-00000000010${index}` })) };
          }
          if (sql.includes('record_emergency_contact_notification_outcome')) {
            events.push('outcome');
            return { rows: [{ next_status: 'delivered' }] };
          }
          return { rows: [] };
        });
        jest.mocked(Pool).mockImplementation(() => ({
          on: jest.fn(),
          connect: jest.fn(async () => {
            if (ended) throw new Error('Cannot use a pool after calling end on the pool');
            return { query, release: jest.fn() };
          }),
          end: jest.fn(async () => { ended = true; events.push('pool ended'); }),
        }) as unknown as Pool);
        // The first send is held until shutdown has begun; any later send would be answered at once.
        let release: (() => void) | undefined;
        const deliverEmergencyContactAlert = jest.fn(() => {
          events.push('send');
          const accepted = { outcome: 'accepted', provider: 'brevo' };
          return release ? Promise.resolve(accepted) : new Promise((resolve) => { release = () => resolve(accepted); });
        });
        const app = await Test.createTestingModule({
          imports: [DatabaseModule],
          providers: [PatientLifecycleSweeper, EmergencyContactNotificationDispatcher, EmergencyContactProtector,
            { provide: NotificationOtpClient, useValue: { deliverEmergencyContactAlert } }],
        }).compile();
        await app.init();
        const tick = app.get(PatientLifecycleSweeper).runOnce();
        for (let turn = 0; turn < 50 && deliverEmergencyContactAlert.mock.calls.length === 0; turn += 1) await flush();
        expect(events).toEqual(['claim', 'send']);

        let closed = false;
        const shutdown = app.close().then(() => { closed = true; });
        await flush();
        expect({ closed, events }).toEqual({ closed: false, events: ['claim', 'send'] });
        release?.();
        await shutdown;
        await tick;
        expect(events).toEqual(['claim', 'send', 'outcome', 'pool ended']);
        expect(deliverEmergencyContactAlert).toHaveBeenCalledTimes(1);
        const outcome = query.mock.calls.find(([sql]) => sql.includes('record_emergency_contact_notification_outcome'));
        expect((outcome as unknown as [string, unknown[]])[1]).toEqual(
          expect.arrayContaining(['c0000000-0000-4000-8000-000000000100', 'accepted', 'brevo']));
      });

    it('waits at shutdown for the tick in flight for at most the alert timeout plus five seconds', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      try {
        const dispatcher = { dispatch: jest.fn(() => new Promise(() => undefined)), stop: jest.fn() };
        const sweeper = new PatientLifecycleSweeper(dispatcher as unknown as EmergencyContactNotificationDispatcher);
        void sweeper.runOnce();
        const bound = getEnvironment().EMERGENCY_CONTACT_ALERT_TIMEOUT_MS + PATIENT_LIFECYCLE_SHUTDOWN_GRACE_MS;
        expect(bound).toBe(17_000);
        let done = false;
        const shutdown = sweeper.beforeApplicationShutdown().then(() => { done = true; });
        expect(dispatcher.stop).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(bound - 1);
        expect(done).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await shutdown;
        expect(done).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('with delivery enabled and a zero interval', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', PATIENT_LIFECYCLE_SWEEP_SECONDS: '0' });

    it('warns once at boot that no alert will be sent', () => {
      const sweeper = new PatientLifecycleSweeper({ dispatch: jest.fn() } as unknown as EmergencyContactNotificationDispatcher);
      const warn = jest.spyOn((sweeper as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      sweeper.onApplicationBootstrap();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('PATIENT_LIFECYCLE_SWEEP_SECONDS is 0');
    });
  });

  describe('with delivery disabled', () => {
    usePatientSafetyTestEnvironment({ ...outsideTests, EMERGENCY_CONTACT_DELIVERY_ENABLED: 'false', PATIENT_LIFECYCLE_SWEEP_SECONDS: '0' });

    it('starts no timer and warns about nothing', () => {
      const interval = jest.spyOn(global, 'setInterval');
      try {
        const sweeper = new PatientLifecycleSweeper({ dispatch: jest.fn() } as unknown as EmergencyContactNotificationDispatcher);
        const warn = jest.spyOn((sweeper as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');
        sweeper.onApplicationBootstrap();
        expect(interval).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        sweeper.onApplicationShutdown();
      } finally {
        interval.mockRestore();
      }
    });
  });

  describe('with delivery enabled outside tests', () => {
    usePatientSafetyTestEnvironment({ ...outsideTests, EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true',
      PATIENT_LIFECYCLE_SWEEP_SECONDS: '60' });

    it('starts one unreferenced timer at the configured interval and clears it on shutdown', () => {
      const sweeper = new PatientLifecycleSweeper({ dispatch: jest.fn() } as unknown as EmergencyContactNotificationDispatcher);
      const interval = jest.spyOn(global, 'setInterval');
      const clear = jest.spyOn(global, 'clearInterval');
      try {
        sweeper.onApplicationBootstrap();
        expect(interval).toHaveBeenCalledTimes(1);
        expect(interval.mock.calls[0]?.[1]).toBe(60_000);
        sweeper.onApplicationShutdown();
        expect(clear).toHaveBeenCalledTimes(1);
      } finally {
        interval.mockRestore();
        clear.mockRestore();
      }
    });
  });
});
