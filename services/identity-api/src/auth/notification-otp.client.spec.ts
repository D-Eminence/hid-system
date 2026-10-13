import { Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEnvironmentForTests } from '../config/environment';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { NotificationOtpClient } from './notification-otp.client';

const originalEnvironment = { ...process.env };
const originalFetch = global.fetch;

describe('NotificationOtpClient signup delivery', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NOTIFICATION_API_URL: 'http://127.0.0.1:3007',
      NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
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

  it('sends signup OTP through the SMS delivery plan and stable challenge idempotency key', async () => {
    const plan = { primary: { provider: 'test_sms' }, fallback: null };
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue(plan) };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      outcome: 'accepted', primary: { provider: 'test_sms' },
    }), { status: 200 }));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    const result = await client.deliver({ challengeId: 'challenge-7', recipient: '+2348012345678',
      code: '012345', purpose: 'SIGNUP_VERIFY', channel: 'sms', correlationId: 'request-7' });

    expect(integrations.deliveryPlan).toHaveBeenCalledWith('sms');
    expect(result).toEqual({ outcome: 'accepted', provider: 'test_sms' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3007/api/v1/notifications/otp');
    expect(init.headers).toEqual(expect.objectContaining({
      'idempotency-key': 'otp:challenge-7', 'x-correlation-id': 'request-7',
      'x-hid-service-token': 'test-service-token-with-32-characters',
    }));
    expect(JSON.parse(String(init.body))).toEqual({ channel: 'sms', recipient: '+2348012345678',
      code: '012345', purpose: 'SIGNUP_VERIFY', plan });
  });

  it('fails closed when the chosen channel has no runtime delivery plan', async () => {
    const integrations = { deliveryPlan: jest.fn().mockRejectedValue(new Error('no SMS plan')) };
    global.fetch = jest.fn();
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await expect(client.deliver({ challengeId: 'challenge-7', recipient: '+2348012345678',
      code: '012345', purpose: 'SIGNUP_VERIFY', channel: 'sms', correlationId: 'request-7' }))
      .resolves.toEqual({ outcome: 'definitive_failure' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('retains email as the default channel for account recovery', async () => {
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: { provider: 'ses' } }) };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ outcome: 'accepted' }), { status: 200 }));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await client.deliver({ challengeId: 'challenge-8', recipient: 'patient@example.test', code: '012345',
      purpose: 'PASSWORD_RESET', correlationId: 'request-8' });
    expect(integrations.deliveryPlan).toHaveBeenCalledWith('email');
    expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body)).channel).toBe('email');
  });

  it('sends a minimum-necessary emergency-contact alert with a stable notification idempotency key', async () => {
    const plan = { capability: 'sms', primary: 'termii', fallback: null, configuration: {} };
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue(plan) };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      outcome: 'accepted', primary: { provider: 'termii' },
    }), { status: 202 }));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await expect(client.deliverEmergencyContactAlert({
      notificationId: 'c0000000-0000-4000-8000-000000000001', channel: 'sms', recipient: '+2348031234567',
      patientFirstName: 'Ada', facilityName: 'Lagos General', occurredAt: new Date('2026-10-08T09:15:00.000Z'),
      correlationId: 'request-9',
    })).resolves.toEqual({ outcome: 'accepted', provider: 'termii' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3007/api/v1/notifications/emergency-contact-alert');
    expect(init.headers).toEqual(expect.objectContaining({
      'idempotency-key': 'emergency-contact:c0000000-0000-4000-8000-000000000001',
    }));
    expect(JSON.parse(String(init.body))).toEqual({ channel: 'sms', recipient: '+2348031234567',
      patientFirstName: 'Ada', facilityName: 'Lagos General', occurredAt: '2026-10-08T09:15:00.000Z', plan });
  });

  it('treats a missing delivery plan for an alert as retryable, not as sent', async () => {
    const integrations = { deliveryPlan: jest.fn().mockRejectedValue(new Error('no plan')) };
    global.fetch = jest.fn();
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await expect(client.deliverEmergencyContactAlert({
      notificationId: 'c0000000-0000-4000-8000-000000000002', channel: 'email', recipient: 'ada@example.test',
      patientFirstName: 'Ada', facilityName: null, occurredAt: new Date(), correlationId: 'request-10',
    })).resolves.toEqual({ outcome: 'unknown', safeCode: 'delivery_policy_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('NotificationOtpClient workload token in JWT mode', () => {
  let directory: string;
  let warn: jest.SpyInstance;
  const otp = { challengeId: 'challenge-11', recipient: '+2348012345678', code: '654321',
    purpose: 'SIGNUP_VERIFY' as const, channel: 'sms' as const, correlationId: 'request-11' };
  const alert = { notificationId: 'c0000000-0000-4000-8000-000000000011', channel: 'sms' as const,
    recipient: '+2348031234567', patientFirstName: 'Ada', facilityName: 'Lagos General',
    occurredAt: new Date('2026-10-08T09:15:00.000Z'), correlationId: 'request-12' };
  const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: { provider: 'test_sms' } }) };
  const client = () => new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
  // Read through Reflect so this suite also runs, and fails, against a client without the counter.
  const unavailableCount = (notification: NotificationOtpClient): unknown =>
    Reflect.get(notification, 'workloadTokenUnavailableCount');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hid-notification-token-'));
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NOTIFICATION_API_URL: 'http://127.0.0.1:3007',
      NOTIFICATION_SERVICE_IDENTITY_MODE: 'jwt',
      NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: join(directory, 'notification.jwt'),
    });
    delete process.env.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN;
    resetEnvironmentForTests();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      outcome: 'accepted', primary: { provider: 'test_sms' } }), { status: 200 }));
  });

  afterEach(async () => {
    warn.mockRestore();
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
    await rm(directory, { recursive: true, force: true });
  });

  it('sends the token file as the workload bearer credential', async () => {
    await writeFile(join(directory, 'notification.jwt'), 'header.payload.signature-from-the-agent\n');
    await expect(client().deliver(otp)).resolves.toEqual({ outcome: 'accepted', provider: 'test_sms' });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({
      'x-hid-service-authorization': 'Bearer header.payload.signature-from-the-agent' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends nothing without a token file, and logs and counts each refusal without personal data', async () => {
    const notification = client();
    await expect(notification.deliver(otp))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'workload_token_unavailable' });
    await expect(notification.deliver({ ...otp, challengeId: 'challenge-12' }))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'workload_token_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(unavailableCount(notification)).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    const lines = warn.mock.calls.map(([message]) => String(message));
    expect(lines[1]).toContain('notification_workload_token_unavailable');
    expect(lines[1]).toContain('reason=missing');
    expect(lines[1]).toContain('count=2');
    for (const line of lines) {
      for (const secret of [otp.recipient, otp.code, otp.challengeId, directory]) expect(line).not.toContain(secret);
    }
  });

  it('refuses an empty or malformed token file the same way', async () => {
    await writeFile(join(directory, 'notification.jwt'), 'two words');
    const notification = client();
    await expect(notification.deliver(otp))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'workload_token_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(unavailableCount(notification)).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('reason=invalid');
  });

  // The agent removes a file before its token expires, but a file stays if the
  // agent stops and ECS does not restart it (an exit within the 60-second
  // restart attempt period). Notification would refuse the expired token 401,
  // a definitive failure, so an alert would never be retried.
  const workloadToken = (exp: number) => [{ alg: 'ES256', typ: 'JWT', kid: 'synthetic-key' },
    { sub: 'hid:staging:identity-api', aud: 'hid-notification-api', iat: exp - 300, exp }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.synthetic-signature';

  it('treats an expired token file as unavailable: an OTP is not sent and an alert stays retryable', async () => {
    await writeFile(join(directory, 'notification.jwt'), `${workloadToken(Math.floor(Date.now() / 1000) - 1)}\n`);
    const notification = client();
    await expect(notification.deliver(otp))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'workload_token_unavailable' });
    await expect(notification.deliverEmergencyContactAlert(alert))
      .resolves.toEqual({ outcome: 'unknown', safeCode: 'workload_token_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(unavailableCount(notification)).toBe(2);
    const lines = warn.mock.calls.map(([message]) => String(message));
    expect(lines[1]).toContain('notification_workload_token_unavailable');
    expect(lines[1]).toContain('reason=expired');
    expect(lines[1]).toContain('count=2');
  });

  it('sends a token whose expiry has not passed', async () => {
    const token = workloadToken(Math.floor(Date.now() / 1000) + 120);
    await writeFile(join(directory, 'notification.jwt'), token);
    await expect(client().deliver(otp)).resolves.toEqual({ outcome: 'accepted', provider: 'test_sms' });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'x-hid-service-authorization': `Bearer ${token}` }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps an emergency-contact alert retryable while the token is missing', async () => {
    const notification = client();
    await expect(notification.deliverEmergencyContactAlert(alert))
      .resolves.toEqual({ outcome: 'unknown', safeCode: 'workload_token_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(unavailableCount(notification)).toBe(1);
    for (const secret of [alert.recipient, alert.patientFirstName, alert.notificationId]) {
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(secret);
    }
  });
});
