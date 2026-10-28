import { fakeDatabase, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';
import { syntheticVapidPublicKey } from '../../test/web-push.fixtures';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { DatabaseService } from '../database/database.service';
import type { AccountDeletionNoticeDispatcher } from '../patient-safety/account-deletion-notice.dispatcher';
import type { EmergencyContactNotificationDispatcher } from '../patient-safety/emergency-contact-notification.dispatcher';
import type { PatientAccountDeletionService } from '../patient-safety/patient-account-deletion.service';
import { PatientLifecycleSweeper, PATIENT_LIFECYCLE_SHUTDOWN_GRACE_MS } from '../patient-safety/patient-lifecycle.sweeper';
import type { RecordAccessAlertDispatcher } from '../patient-safety/record-access-alert.dispatcher';
import {
  WEB_PUSH_CLAIM_BATCHES, WEB_PUSH_CLAIM_LEASE_SECONDS, WEB_PUSH_CLAIM_LIMIT, WEB_PUSH_DELIVERY_TIMEOUT_MS,
  WEB_PUSH_PRUNE_BATCH, WebPushDispatcher,
} from './web-push.dispatcher';
import { WebPushProtector } from './web-push.protector';
import { webPushKeyId } from './web-push-endpoint';

const publicKey = syntheticVapidPublicKey();
const keyId = webPushKeyId(Buffer.from(publicKey, 'base64url'));
const pushOn = { WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_SUBJECT: 'mailto:support@healthidentitydirectory.com' };
const endpoint = (index: number) => `https://fcm.googleapis.com/fcm/send/synthetic-${index}`;
const claimedThrough = new Date('2026-10-28T10:00:00.123Z');

function dispatcherWith(deliverWebPush: jest.Mock, claims: Array<(protector: WebPushProtector) => unknown[]>,
  outcome: string | ((values: unknown[]) => string) = 'delivered') {
  const fake = fakeDatabase();
  const protector = new WebPushProtector();
  fake.query.mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes('claim_web_push_deliveries')) return { rows: claims.shift()?.(protector) ?? [] };
    if (sql.includes('record_web_push_outcome')) return { rows: [{ next: typeof outcome === 'string' ? outcome : outcome(values) }] };
    if (sql.includes('prune_web_push_subscriptions')) return { rows: [{ removed: 3 }] };
    return { rows: [] };
  });
  const dispatcher = new WebPushDispatcher(fake.database, { deliverWebPush } as unknown as NotificationOtpClient, protector);
  const log = jest.spyOn((dispatcher as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
    .mockImplementation(() => undefined);
  return { ...fake, dispatcher, protector, log };
}

const row = (protector: WebPushProtector, index: number, value = endpoint(index)) => {
  const id = `6a1e0000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return { subscription_id: id, endpoint_ciphertext: protector.encrypt(id, value), endpoint_key_version: 'test-v1',
    push_service: 'fcm', attempt_count: 0, claimed_through: claimedThrough };
};

describe('WebPushDispatcher (B6, 0097)', () => {
  it('keeps ten sends inside the lease', () => {
    expect(WEB_PUSH_CLAIM_LIMIT * WEB_PUSH_DELIVERY_TIMEOUT_MS).toBeLessThan(WEB_PUSH_CLAIM_LEASE_SECONDS * 1000);
    expect([WEB_PUSH_CLAIM_LIMIT, WEB_PUSH_CLAIM_LEASE_SECONDS, WEB_PUSH_CLAIM_BATCHES, WEB_PUSH_PRUNE_BATCH,
      WEB_PUSH_DELIVERY_TIMEOUT_MS]).toEqual([10, 120, 5, 100, 8000]);
  });

  describe('while push is on', () => {
    usePatientSafetyTestEnvironment(pushOn);

    it('claims with its worker and the current key id, sends the decrypted endpoint, records each outcome', async () => {
      const deliver = jest.fn()
        .mockResolvedValueOnce({ outcome: 'accepted' })
        .mockResolvedValueOnce({ outcome: 'retry', retryAfterSeconds: 120, safeCode: 'push_429' });
      const outcomes = ['delivered', 'retrying'];
      const { dispatcher, query, log } = dispatcherWith(deliver, [(protector) => [row(protector, 1), row(protector, 2)]],
        () => outcomes.shift()!);
      await expect(dispatcher.dispatch('patient-lifecycle-1'))
        .resolves.toEqual({ claimed: 2, delivered: 1, retried: 1, dropped: 0, removed: 0 });
      const claim = query.mock.calls.find(([sql]) => String(sql).includes('claim_web_push_deliveries'))!;
      expect(claim[1]).toEqual([expect.stringMatching(/^identity-api:[0-9a-f-]{36}$/), WEB_PUSH_CLAIM_LIMIT,
        WEB_PUSH_CLAIM_LEASE_SECONDS, keyId]);
      expect(deliver).toHaveBeenNthCalledWith(1, { subscriptionId: '6a1e0000-0000-4000-8000-000000000001',
        endpoint: endpoint(1), vapidKeyId: keyId, claimedThrough, correlationId: 'patient-lifecycle-1' });
      const recorded = query.mock.calls.filter(([sql]) => String(sql).includes('record_web_push_outcome')).map(([, values]) => values);
      expect(recorded).toEqual([
        ['6a1e0000-0000-4000-8000-000000000001', claim[1][0], 'accepted', null, null],
        ['6a1e0000-0000-4000-8000-000000000002', claim[1][0], 'retry', 120, 'push_429'],
      ]);
      expect(log.mock.calls.map(([message]) => message)).toEqual([
        'Web push dispatch (event=web_push_dispatch claimed=2 delivered=1 retried=1 dropped=0 removed=0)']);
    });

    it('records gone as removed and counts drops', async () => {
      const deliver = jest.fn().mockResolvedValueOnce({ outcome: 'gone', safeCode: 'push_410' })
        .mockResolvedValueOnce({ outcome: 'rejected', safeCode: 'push_400' });
      const outcomes = ['removed', 'dropped'];
      const { dispatcher, query } = dispatcherWith(deliver, [(protector) => [row(protector, 1), row(protector, 2)]],
        () => outcomes.shift()!);
      await expect(dispatcher.dispatch('c')).resolves.toMatchObject({ removed: 1, dropped: 1 });
      expect(query.mock.calls.filter(([sql]) => String(sql).includes('record_web_push_outcome')).map(([, values]) => values[2]))
        .toEqual(['gone', 'rejected']);
    });

    it('records a ciphertext it cannot open, or an endpoint that fails rule E, as rejected without sending', async () => {
      const deliver = jest.fn();
      const { dispatcher, query } = dispatcherWith(deliver, [(protector) => [
        { ...row(protector, 1), endpoint_key_version: 'old-v0' },
        { ...row(protector, 2), subscription_id: '6a1e0000-0000-4000-8000-000000000099' },
        row(protector, 3, 'https://evil.example/push'),
      ]], 'dropped');
      await dispatcher.dispatch('c');
      expect(deliver).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) => String(sql).includes('record_web_push_outcome')).map(([, values]) => values.slice(2)))
        .toEqual([['rejected', null, 'endpoint_protection_unavailable'], ['rejected', null, 'endpoint_protection_unavailable'],
          ['rejected', null, 'endpoint_invalid']]);
    });

    it('records a send that throws as a retry', async () => {
      const deliver = jest.fn().mockRejectedValue(new Error('socket hang up'));
      const { dispatcher, query } = dispatcherWith(deliver, [(protector) => [row(protector, 1)]], 'retrying');
      await expect(dispatcher.dispatch('c')).resolves.toMatchObject({ retried: 1 });
      const recorded = query.mock.calls.find(([sql]) => String(sql).includes('record_web_push_outcome'))!;
      expect(recorded[1].slice(2)).toEqual(['retry', null, 'transport_error']);
    });

    it('claims again only after a full claim, at most five times a tick', async () => {
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted' });
      const full = (protector: WebPushProtector) => Array.from({ length: WEB_PUSH_CLAIM_LIMIT }, (_, index) => row(protector, index + 1));
      const { dispatcher, query } = dispatcherWith(deliver, Array.from({ length: 7 }, () => full));
      await dispatcher.dispatch('c');
      expect(query.mock.calls.filter(([sql]) => String(sql).includes('claim_web_push_deliveries'))).toHaveLength(WEB_PUSH_CLAIM_BATCHES);
      const partial = dispatcherWith(deliver, [full, (protector) => [row(protector, 1)], full]);
      await partial.dispatcher.dispatch('c');
      expect(partial.query.mock.calls.filter(([sql]) => String(sql).includes('claim_web_push_deliveries'))).toHaveLength(2);
    });

    it('claims and sends nothing once stopped', async () => {
      const deliver = jest.fn();
      const { dispatcher, query } = dispatcherWith(deliver, [(protector) => [row(protector, 1)]]);
      dispatcher.stop();
      await dispatcher.dispatch('c');
      await dispatcher.prune('c');
      expect(query).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });

    it('prunes 100 at a time and logs the count only', async () => {
      const { dispatcher, query, log } = dispatcherWith(jest.fn(), []);
      await expect(dispatcher.prune('c')).resolves.toBe(3);
      expect(query.mock.calls[0]).toEqual(['select identity.prune_web_push_subscriptions($1) as removed', [WEB_PUSH_PRUNE_BATCH]]);
      expect(log.mock.calls).toEqual([['Web push prune (event=web_push_prune removed=3)']]);
    });

    it('logs nothing about endpoints, keys or ids', async () => {
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted' });
      const { dispatcher, log } = dispatcherWith(deliver, [(protector) => [row(protector, 1)]]);
      await dispatcher.dispatch('c');
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toMatch(/fcm|6a1e|synthetic|test-v1/);
      expect(logged).not.toContain(keyId);
    });
  });

  describe('while push is off', () => {
    usePatientSafetyTestEnvironment({ WEB_PUSH_VAPID_PUBLIC_KEY: '', WEB_PUSH_SUBJECT: '' });

    it('claims and sends nothing, but still prunes', async () => {
      const deliver = jest.fn();
      const { dispatcher, query } = dispatcherWith(deliver, [(protector) => [row(protector, 1)]]);
      await expect(dispatcher.dispatch('c')).resolves.toEqual({ claimed: 0, delivered: 0, retried: 0, dropped: 0, removed: 0 });
      expect(query).not.toHaveBeenCalled();
      await expect(dispatcher.prune('c')).resolves.toBe(3);
    });
  });

  describe('while push is on but the contact key is missing', () => {
    usePatientSafetyTestEnvironment({ ...pushOn, NIN_ENCRYPTION_KEY_B64: '' });

    it('claims nothing (a claim it cannot open would count against the subscription)', async () => {
      const { dispatcher, query } = dispatcherWith(jest.fn(), []);
      await dispatcher.dispatch('c');
      expect(query).not.toHaveBeenCalled();
    });
  });
});

describe('PatientLifecycleSweeper web push steps (B6)', () => {
  function sweeperWith(fail: string[] = []) {
    const order: string[] = [];
    const step = (name: string) => jest.fn(async () => {
      order.push(name);
      if (fail.includes(name)) throw Object.assign(new Error('Ada https://fcm.googleapis.com/x'), { code: 'XX000' });
      return name === 'prune' ? 0 : { claimed: 0 };
    });
    const emergency = { dispatch: step('emergency'), stop: jest.fn() };
    const alerts = { dispatch: step('alerts'), stop: jest.fn() };
    const notices = { dispatch: step('notices'), stop: jest.fn() };
    const deletion = { finalizeDue: jest.fn(async () => { order.push('finalize'); return []; }) };
    const webPush = { prune: step('prune'), dispatch: step('push'), stop: jest.fn() };
    const fake = fakeDatabase();
    fake.query.mockImplementation(async (sql: string) => {
      if (sql.includes('expire_share_invitations')) order.push('expire');
      return { rows: [] };
    });
    const sweeper = new PatientLifecycleSweeper(emergency as unknown as EmergencyContactNotificationDispatcher,
      fake.database as DatabaseService, alerts as unknown as RecordAccessAlertDispatcher,
      deletion as unknown as PatientAccountDeletionService, notices as unknown as AccountDeletionNoticeDispatcher,
      webPush as unknown as WebPushDispatcher);
    const error = jest.spyOn((sweeper as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    return { sweeper, order, error, webPush };
  }

  describe('while push is on', () => {
    usePatientSafetyTestEnvironment({ ...pushOn, EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' });

    it('prunes and then dispatches after the 0096 steps, each on its own', async () => {
      const { sweeper, order, error } = sweeperWith(['prune']);
      await sweeper.runOnce();
      expect(order).toEqual(['emergency', 'expire', 'alerts', 'finalize', 'notices', 'prune', 'push']);
      expect(error.mock.calls.map(([message]) => message)).toEqual([expect.stringMatching(/step=web_push_prune, code=XX000/)]);
      expect(error.mock.calls.join(' ')).not.toMatch(/Ada|fcm/);
    });

    it('stops the web push dispatcher at shutdown and waits for the longest send', async () => {
      const { sweeper, webPush, order } = sweeperWith();
      let release!: () => void;
      (webPush.dispatch as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => {
        order.push('push');
        release = () => resolve({ claimed: 0 });
      }));
      const tick = sweeper.runOnce();
      for (let turn = 0; turn < 100 && !order.includes('push'); turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(order).toContain('push');
      jest.useFakeTimers();
      try {
        const shutdown = sweeper.beforeApplicationShutdown();
        expect(webPush.stop).toHaveBeenCalled();
        let finished = false;
        void shutdown.then(() => { finished = true; });
        await jest.advanceTimersByTimeAsync(Math.max(12_000, WEB_PUSH_DELIVERY_TIMEOUT_MS) + PATIENT_LIFECYCLE_SHUTDOWN_GRACE_MS - 1);
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(finished).toBe(true);
      } finally {
        jest.useRealTimers();
      }
      release();
      await tick;
    });
  });

  describe('while push is off', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'false', RECORD_ACCESS_EMAIL_ENABLED: 'false' });

    it('still prunes (ended sign-ins are erased) and dispatches nothing', async () => {
      const { sweeper, order } = sweeperWith();
      await sweeper.runOnce();
      expect(order).toEqual(['expire', 'finalize', 'notices', 'prune']);
    });
  });
});
