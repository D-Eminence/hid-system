import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEnvironmentForTests } from '../config/environment';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { WEB_PUSH_DELIVERY_TIMEOUT_MS } from '../web-push/web-push-endpoint';
import { NotificationOtpClient } from './notification-otp.client';

const originalEnvironment = { ...process.env };
const originalFetch = global.fetch;
const subscriptionId = '6a1e0000-0000-4000-8000-000000000001';
const endpoint = 'https://fcm.googleapis.com/fcm/send/synthetic';
const claimedThrough = new Date('2026-10-28T10:00:00.123Z');
const input = { subscriptionId, endpoint, vapidKeyId: '3f1c0a9e5b7d2e41', claimedThrough, correlationId: 'patient-lifecycle-1' };

describe('NotificationOtpClient.deliverWebPush (B6, N1)', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NOTIFICATION_API_URL: 'http://127.0.0.1:3007/', NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
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

  const deliveryPlan = jest.fn();
  function client(answer: Response | Error) {
    global.fetch = answer instanceof Response ? jest.fn().mockResolvedValue(answer) : jest.fn().mockRejectedValue(answer);
    return new NotificationOtpClient({ deliveryPlan } as unknown as IntegrationRuntimeService);
  }
  const json = (body: unknown, status = 202) => new Response(JSON.stringify(body), { status });

  it('posts the endpoint and key id only, keyed by the round, workload-authenticated, with no delivery plan', async () => {
    const notification = client(json({ requestId: 'r', outcome: 'accepted', pushStatus: 201, retryAfterSeconds: null, safeCode: null }));
    await expect(notification.deliverWebPush(input)).resolves.toEqual({ outcome: 'accepted' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:3007/api/v1/notifications/web-push');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ endpoint, vapidKeyId: '3f1c0a9e5b7d2e41' });
    expect(init.headers).toEqual({ 'content-type': 'application/json',
      'idempotency-key': `web-push:${subscriptionId}:${claimedThrough.getTime()}`, 'x-correlation-id': 'patient-lifecycle-1',
      'x-hid-internal-caller': 'identity-api', 'x-hid-service-token': 'test-service-token-with-32-characters' });
    expect(init.headers['idempotency-key']).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(deliveryPlan).not.toHaveBeenCalled();
    expect(WEB_PUSH_DELIVERY_TIMEOUT_MS).toBe(8000);
  });

  it.each([
    [{ outcome: 'gone', safeCode: 'push_410' }, { outcome: 'gone', safeCode: 'push_410' }],
    [{ outcome: 'retry', retryAfterSeconds: 120, safeCode: 'push_429' }, { outcome: 'retry', retryAfterSeconds: 120, safeCode: 'push_429' }],
    [{ outcome: 'retry', retryAfterSeconds: 99999, safeCode: 'push_5xx' }, { outcome: 'retry', retryAfterSeconds: 3600, safeCode: 'push_5xx' }],
    [{ outcome: 'retry', retryAfterSeconds: 0 }, { outcome: 'retry', retryAfterSeconds: 1 }],
    [{ outcome: 'rejected', safeCode: 'push_400' }, { outcome: 'rejected', safeCode: 'push_400' }],
    [{ outcome: 'accepted', safeCode: 'Not A Code' }, { outcome: 'accepted' }],
    [{ outcome: 'delivered' }, { outcome: 'retry', safeCode: 'bad_response' }],
    [[], { outcome: 'retry', safeCode: 'bad_response' }],
  ])('maps a 202 %j to %j', async (body, expected) => {
    await expect(client(json(body)).deliverWebPush(input)).resolves.toEqual(expected);
  });

  it.each([
    [202, 'not json', { outcome: 'retry', safeCode: 'bad_response' }],
    [200, '{"outcome":"accepted"}', { outcome: 'retry', safeCode: 'bad_response' }],
    [404, '{"code":"WEB_PUSH_NOT_CONFIGURED"}', { outcome: 'retry', safeCode: 'notification_404' }],
    [409, '{}', { outcome: 'retry', safeCode: 'key_mismatch' }],
    [401, '{}', { outcome: 'retry', safeCode: 'http_401' }],
    [403, '{}', { outcome: 'retry', safeCode: 'http_403' }],
    [400, '{}', { outcome: 'rejected', safeCode: 'http_400' }],
    [422, '{}', { outcome: 'rejected', safeCode: 'http_422' }],
    [408, '{}', { outcome: 'retry', safeCode: 'http_408' }],
    [429, '{}', { outcome: 'retry', safeCode: 'http_429' }],
    [500, '{}', { outcome: 'retry', safeCode: 'http_500' }],
    [503, '{}', { outcome: 'retry', safeCode: 'http_503' }],
  ])('maps notification-api %i %s; a 404 from it never removes a subscription', async (status, body, expected) => {
    await expect(client(new Response(body, { status })).deliverWebPush(input)).resolves.toEqual(expected);
  });

  it('retries a timeout or a transport error', async () => {
    await expect(client(new DOMException('timed out', 'TimeoutError') as unknown as Error).deliverWebPush(input))
      .resolves.toEqual({ outcome: 'retry', safeCode: 'transport_error' });
    await expect(client(new TypeError('fetch failed')).deliverWebPush(input))
      .resolves.toEqual({ outcome: 'retry', safeCode: 'transport_error' });
  });

  it('sends nothing and retries without a workload token in JWT mode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hid-web-push-token-'));
    try {
      Object.assign(process.env, { NOTIFICATION_SERVICE_IDENTITY_MODE: 'jwt',
        NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: join(directory, 'missing.jwt') });
      delete process.env.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN;
      resetEnvironmentForTests();
      const notification = client(json({ outcome: 'accepted' }));
      jest.spyOn((notification as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
      await expect(notification.deliverWebPush(input)).resolves.toEqual({ outcome: 'retry', safeCode: 'workload_token_unavailable' });
      expect(global.fetch).not.toHaveBeenCalled();
      writeFileSync(join(directory, 'token.jwt'), 'header.payload.signature');
      process.env.NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE = join(directory, 'token.jwt');
      resetEnvironmentForTests();
      const withToken = client(json({ outcome: 'accepted' }));
      await withToken.deliverWebPush(input);
      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(init.headers['x-hid-service-authorization']).toBe('Bearer header.payload.signature');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
