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

  const alert = {
    notificationId: 'c0000000-0000-4000-8000-000000000001', channel: 'email' as const, recipient: 'chidi@example.test',
    patientFullName: 'Amina Okafor', patientHidSuffix: 'EF23', clinicianName: 'Dr Bola Adeyemi',
    facilityName: 'Lagos General', facilityPhone: '+2348030000000', occurredAt: new Date('2026-10-23T13:35:00.000Z'),
    correlationId: 'request-9',
  };

  it('sends the emergency-contact alert fields with a stable notification idempotency key', async () => {
    const plan = { capability: 'email', primary: 'brevo', fallback: null, configuration: {} };
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue(plan) };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      outcome: 'accepted', primary: { provider: 'brevo' },
    }), { status: 202 }));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await expect(client.deliverEmergencyContactAlert(alert)).resolves.toEqual({ outcome: 'accepted', provider: 'brevo' });
    expect(integrations.deliveryPlan).toHaveBeenCalledWith('email');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3007/api/v1/notifications/emergency-contact-alert');
    expect(init.headers).toEqual(expect.objectContaining({
      'idempotency-key': 'emergency-contact:c0000000-0000-4000-8000-000000000001', 'x-correlation-id': 'request-9',
      'x-hid-service-token': 'test-service-token-with-32-characters',
    }));
    // No reason field and no full Health ID: the body has no free-text slot.
    expect(JSON.parse(String(init.body))).toEqual({ channel: 'email', recipient: 'chidi@example.test',
      patientFullName: 'Amina Okafor', patientHidSuffix: 'EF23', clinicianName: 'Dr Bola Adeyemi',
      facilityName: 'Lagos General', facilityPhone: '+2348030000000', occurredAt: '2026-10-23T13:35:00.000Z', plan });
  });

  it('sends null for a missing clinician, facility and facility phone', async () => {
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: 'brevo' }) };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ outcome: 'accepted' }), { status: 202 }));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await client.deliverEmergencyContactAlert({ ...alert, clinicianName: null, facilityName: null, facilityPhone: null });
    expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body))).toMatchObject({
      clinicianName: null, facilityName: null, facilityPhone: null });
  });

  it('treats a missing delivery plan for an alert as retryable, not as sent', async () => {
    const integrations = { deliveryPlan: jest.fn().mockRejectedValue(new Error('no plan')) };
    global.fetch = jest.fn();
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await expect(client.deliverEmergencyContactAlert({ ...alert, notificationId: 'c0000000-0000-4000-8000-000000000002' }))
      .resolves.toEqual({ outcome: 'unknown', safeCode: 'delivery_policy_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [503, 'unknown'], [502, 'unknown'], [500, 'unknown'], [429, 'unknown'], [408, 'unknown'], [401, 'unknown'],
    [403, 'definitive_failure'], [400, 'definitive_failure'], [404, 'definitive_failure'],
  ] as const)('maps an alert answered %i to %s with a safe code', async (status, outcome) => {
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: 'brevo' }) };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'ANY' }), { status }));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await expect(client.deliverEmergencyContactAlert(alert)).resolves.toEqual({ outcome, safeCode: `http_${status}` });
  });

  // notification-api also answers 401 when it cannot fetch its verification keys.
  it('retries an alert answered 401, but not a code answered 401 nor an alert answered 403', async () => {
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: 'brevo' }) };
    const answer = (status: number) => async () => new Response(JSON.stringify({ code: 'ANY' }), { status });
    global.fetch = jest.fn().mockImplementation(answer(401));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await expect(client.deliverEmergencyContactAlert(alert)).resolves.toEqual({ outcome: 'unknown', safeCode: 'http_401' });
    for (const purpose of ['SIGNUP_VERIFY', 'PASSWORD_RESET', 'EMERGENCY_CONTACT_VERIFY'] as const) {
      await expect(client.deliver({ challengeId: 'challenge-401', recipient: 'ada@example.test', code: '012345',
        purpose, channel: 'email', correlationId: 'request-401' }))
        .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'http_401' });
    }
    (global.fetch as jest.Mock).mockImplementation(answer(403));
    await expect(client.deliverEmergencyContactAlert(alert))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'http_403' });
    expect((global.fetch as jest.Mock).mock.calls.map(([url]) => String(url).split('/').at(-1)))
      .toEqual(['emergency-contact-alert', 'otp', 'otp', 'otp', 'emergency-contact-alert']);
  });

  it('keeps a transport failure retryable', async () => {
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: 'brevo' }) };
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout'));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await expect(client.deliverEmergencyContactAlert(alert)).resolves.toEqual({ outcome: 'unknown', safeCode: 'transport_error' });
  });

  it('waits up to the alert timeout (12 s by default) for an alert and 5 s for a code', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    try {
      const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: 'brevo' }) };
      global.fetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ outcome: 'accepted' }), { status: 202 }));
      const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
      await client.deliverEmergencyContactAlert(alert);
      await client.deliver({ challengeId: 'challenge-9', recipient: 'ada@example.test', code: '012345',
        purpose: 'EMERGENCY_CONTACT_VERIFY', channel: 'email', correlationId: 'request-9' });
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([12_000, 5_000]);
      process.env.EMERGENCY_CONTACT_ALERT_TIMEOUT_MS = '20000'; resetEnvironmentForTests();
      await new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService).deliverEmergencyContactAlert(alert);
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(20_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('sends an emergency-contact verification code through the OTP route', async () => {
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: 'brevo' }) };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ outcome: 'accepted' }), { status: 200 }));
    const client = new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
    await client.deliver({ challengeId: 'challenge-10', recipient: 'ada@example.test', code: '012345',
      purpose: 'EMERGENCY_CONTACT_VERIFY', channel: 'email', correlationId: 'request-10' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3007/api/v1/notifications/otp');
    expect(JSON.parse(String(init.body))).toMatchObject({ purpose: 'EMERGENCY_CONTACT_VERIFY', channel: 'email' });
  });
});

describe('NotificationOtpClient workload token in JWT mode', () => {
  let directory: string;
  let warn: jest.SpyInstance;
  const otp = { challengeId: 'challenge-11', recipient: '+2348012345678', code: '654321',
    purpose: 'SIGNUP_VERIFY' as const, channel: 'sms' as const, correlationId: 'request-11' };
  const alert = { notificationId: 'c0000000-0000-4000-8000-000000000011', channel: 'email' as const,
    recipient: 'chidi@example.test', patientFullName: 'Amina Okafor', patientHidSuffix: 'EF23',
    clinicianName: 'Dr Bola Adeyemi', facilityName: 'Lagos General', facilityPhone: null,
    occurredAt: new Date('2026-10-08T09:15:00.000Z'), correlationId: 'request-12' };
  const integrations = { deliveryPlan: jest.fn().mockResolvedValue({ primary: { provider: 'test_sms' } }) };
  const client = () => new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);

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

  it('sends no code without a token file, and logs and counts each refusal without personal data', async () => {
    const notification = client();
    await expect(notification.deliver(otp))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'workload_token_unavailable' });
    await expect(notification.deliver({ ...otp, challengeId: 'challenge-12' }))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'workload_token_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(notification.workloadTokenUnavailableCount).toBe(2);
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
    expect(notification.workloadTokenUnavailableCount).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('reason=invalid');
  });

  const workloadToken = (exp: number) => [{ alg: 'ES256', typ: 'JWT', kid: 'synthetic-key' },
    { sub: 'hid:staging:identity-api', aud: 'hid-notification-api', iat: exp - 300, exp }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.synthetic-signature';

  it('treats an expired token file as unavailable: a code is not sent and an alert stays retryable', async () => {
    await writeFile(join(directory, 'notification.jwt'), `${workloadToken(Math.floor(Date.now() / 1000) - 1)}\n`);
    const notification = client();
    await expect(notification.deliver(otp))
      .resolves.toEqual({ outcome: 'definitive_failure', safeCode: 'workload_token_unavailable' });
    await expect(notification.deliverEmergencyContactAlert(alert))
      .resolves.toEqual({ outcome: 'unknown', safeCode: 'workload_token_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(notification.workloadTokenUnavailableCount).toBe(2);
    const lines = warn.mock.calls.map(([message]) => String(message));
    expect(lines[1]).toContain('reason=expired');
  });

  it('sends a token whose expiry has not passed', async () => {
    const token = workloadToken(Math.floor(Date.now() / 1000) + 120);
    await writeFile(join(directory, 'notification.jwt'), token);
    await expect(client().deliver(otp)).resolves.toEqual({ outcome: 'accepted', provider: 'test_sms' });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'x-hid-service-authorization': `Bearer ${token}` }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps an emergency-contact alert retryable while the token is missing, and logs no alert field', async () => {
    const notification = client();
    await expect(notification.deliverEmergencyContactAlert(alert))
      .resolves.toEqual({ outcome: 'unknown', safeCode: 'workload_token_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(notification.workloadTokenUnavailableCount).toBe(1);
    for (const secret of [alert.recipient, alert.patientFullName, alert.patientHidSuffix, alert.notificationId]) {
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(secret);
    }
  });
});
