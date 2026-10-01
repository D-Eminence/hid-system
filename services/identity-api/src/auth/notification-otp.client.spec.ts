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
});
