import { resetEnvironmentForTests } from '../config/environment';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { NotificationOtpClient } from './notification-otp.client';

const originalEnvironment = { ...process.env };
const originalFetch = global.fetch;
const plan = { primary: { provider: 'ses' }, fallback: null };

describe('NotificationOtpClient sharing emails (0095)', () => {
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

  it('posts E1, E2 and E3 with fixed fields only, each keyed by its record', async () => {
    const notification = client();
    await expect(notification.deliverPatientShareInvitation({ invitationId: 'i-1', recipient: 'dr@example.test',
      reference: 'K7M2Q9XZ', level: 'view_only', duration: '24h', expiresAt: new Date('2026-11-27T10:00:00Z'),
      correlationId: 'c-1' })).resolves.toEqual({ outcome: 'accepted', provider: 'ses' });
    await notification.deliverShareReceived({ consentGrantId: 'g-1', recipient: 'dr@example.test',
      facilityName: 'Lagos General', correlationId: 'c-1' });
    await notification.deliverShareReceived({ consentGrantId: 'g-2', recipient: 'dr@example.test', correlationId: 'c-1' });
    await notification.deliverRecordAccessAlert({ noticeId: 'n-1', recipient: 'patient@example.test',
      occurredAt: new Date('2026-10-28T09:05:00Z'), correlationId: 'c-1' });
    expect(sent()).toEqual([
      { route: 'patient-share-invitation', key: 'patient-share-invitation:i-1', body: { channel: 'email',
        recipient: 'dr@example.test', reference: 'K7M2Q9XZ', level: 'view_only', duration: '24h',
        expiresAt: '2026-11-27T10:00:00.000Z', plan } },
      { route: 'share-received', key: 'share-received:g-1', body: { channel: 'email', recipient: 'dr@example.test',
        facilityName: 'Lagos General', plan } },
      { route: 'share-received', key: 'share-received:g-2', body: { channel: 'email', recipient: 'dr@example.test', plan } },
      { route: 'record-access-alert', key: 'record-access-alert:n-1', body: { channel: 'email',
        recipient: 'patient@example.test', occurredAt: '2026-10-28T09:05:00.000Z', plan } },
    ]);
  });

  it('an older notification-api (404) is a definitive non-send; 401 stays retryable; no plan sends nothing', async () => {
    await expect(client(404).deliverRecordAccessAlert({ noticeId: 'n-1', recipient: 'p@example.test',
      occurredAt: new Date(), correlationId: 'c' })).resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'http_404' });
    await expect(client(401).deliverRecordAccessAlert({ noticeId: 'n-1', recipient: 'p@example.test',
      occurredAt: new Date(), correlationId: 'c' })).resolves.toEqual({ outcome: 'unknown', safeCode: 'http_401' });
    await expect(client(202, null).deliverRecordAccessAlert({ noticeId: 'n-1', recipient: 'p@example.test',
      occurredAt: new Date(), correlationId: 'c' })).resolves.toEqual({ outcome: 'unknown', safeCode: 'delivery_policy_unavailable' });
    await expect(client(202, null).deliverPatientShareInvitation({ invitationId: 'i', recipient: 'd@example.test',
      reference: 'K7M2Q9XZ', level: 'view_only', duration: '24h', expiresAt: new Date(), correlationId: 'c' }))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'delivery_policy_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
