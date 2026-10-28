import { resetEnvironmentForTests } from '../config/environment';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { NotificationOtpClient } from './notification-otp.client';

const originalEnvironment = { ...process.env };
const originalFetch = global.fetch;
const plan = { primary: { provider: 'ses' }, fallback: null };

describe('NotificationOtpClient account-deletion emails (0096, E4)', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NOTIFICATION_API_URL: 'http://127.0.0.1:3007', NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
      NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: 'test-service-token-with-32-characters',
    });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  function client(status = 202, deliveryPlan: unknown = plan) {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ outcome: 'accepted', primary: { provider: 'ses' } }),
      { status }));
    return new NotificationOtpClient({ deliveryPlan: jest.fn().mockResolvedValue(deliveryPlan) } as unknown as IntegrationRuntimeService);
  }
  const sent = () => (global.fetch as jest.Mock).mock.calls.map(([url, init]) => ({
    route: String(url).split('/api/v1/notifications/')[1],
    key: (init as RequestInit & { headers: Record<string, string> }).headers['idempotency-key'],
    body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
  }));
  const requestId = '90000000-0000-4000-8000-000000000001';

  it('posts the kind (and the date for scheduled) only, keyed account-deletion:<requestId>:<kind>', async () => {
    const notification = client();
    await expect(notification.deliverAccountDeletionNotice({ requestId, recipient: 'patient@example.test',
      kind: 'scheduled', scheduledFor: new Date('2026-11-11T10:00:00Z'), correlationId: 'c-1' }))
      .resolves.toEqual({ outcome: 'accepted', provider: 'ses' });
    await notification.deliverAccountDeletionNotice({ requestId, recipient: 'patient@example.test', kind: 'cancelled',
      scheduledFor: new Date('2026-11-11T10:00:00Z'), correlationId: 'c-1' });
    await notification.deliverAccountDeletionNotice({ requestId, recipient: 'patient@example.test', kind: 'completed',
      correlationId: 'c-1' });
    expect(sent()).toEqual([
      { route: 'account-deletion', key: `account-deletion:${requestId}:scheduled`, body: { channel: 'email',
        recipient: 'patient@example.test', kind: 'scheduled', scheduledFor: '2026-11-11T10:00:00.000Z', plan } },
      { route: 'account-deletion', key: `account-deletion:${requestId}:cancelled`, body: { channel: 'email',
        recipient: 'patient@example.test', kind: 'cancelled', plan } },
      { route: 'account-deletion', key: `account-deletion:${requestId}:completed`, body: { channel: 'email',
        recipient: 'patient@example.test', kind: 'completed', plan } },
    ]);
    for (const { key } of sent()) expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
  });

  it('an older notification-api (404) is a definitive non-send; 401 and no plan stay retryable; a scheduled email needs its date', async () => {
    const input = { requestId, recipient: 'p@example.test', kind: 'completed' as const, correlationId: 'c' };
    await expect(client(404).deliverAccountDeletionNotice(input))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'http_404' });
    await expect(client(401).deliverAccountDeletionNotice(input)).resolves.toEqual({ outcome: 'unknown', safeCode: 'http_401' });
    await expect(client(202, null).deliverAccountDeletionNotice(input))
      .resolves.toEqual({ outcome: 'unknown', safeCode: 'delivery_policy_unavailable' });
    await expect(client().deliverAccountDeletionNotice({ ...input, kind: 'scheduled' }))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'scheduled_for_missing' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
