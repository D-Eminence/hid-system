import { TurnstileService } from './turnstile.service';
import { resetEnvironmentForTests } from '../config/environment';

describe('TurnstileService', () => {
  const original = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', DATABASE_SSL: 'false',
      CORS_ORIGINS: 'https://admin.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      TURNSTILE_MODE: 'required',
      // Official Cloudflare always-pass test secret; fetch is still mocked.
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', TURNSTILE_TIMEOUT_MS: '250',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    global.fetch = originalFetch;
    resetEnvironmentForTests();
  });

  const request = { token: 'opaque-turnstile-token', action: 'admin-login' as const,
    origin: 'https://admin.healthidentitydirectory.com', remoteIp: '192.0.2.4' };

  function result(value: object, status = 200) {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(value), { status }));
  }

  it('requires a token', async () => {
    await expect(new TurnstileService().verifyLogin({ ...request, token: '' })).rejects.toMatchObject({ code: 'TURNSTILE_REQUIRED' });
  });

  it('rejects malformed and rejected responses', async () => {
    result({ success: false, 'error-codes': ['invalid-input-response'] });
    await expect(new TurnstileService().verifyLogin(request)).rejects.toMatchObject({ code: 'TURNSTILE_REJECTED' });
  });

  it('rejects replayed or expired tokens', async () => {
    result({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    await expect(new TurnstileService().verifyLogin(request)).rejects.toMatchObject({ code: 'TURNSTILE_EXPIRED_OR_REPLAYED' });
  });

  it('rejects hostname mismatch', async () => {
    result({ success: true, hostname: 'evil.example', action: 'admin-login' });
    await expect(new TurnstileService().verifyLogin(request)).rejects.toMatchObject({ code: 'TURNSTILE_HOSTNAME_MISMATCH' });
  });

  it('rejects action mismatch', async () => {
    result({ success: true, hostname: 'admin.healthidentitydirectory.com', action: 'patient-login' });
    await expect(new TurnstileService().verifyLogin(request)).rejects.toMatchObject({ code: 'TURNSTILE_ACTION_MISMATCH' });
  });

  it('fails closed on timeout', async () => {
    global.fetch = jest.fn().mockRejectedValue(new DOMException('timed out', 'AbortError'));
    await expect(new TurnstileService().verifyLogin(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
  });

  it('accepts a valid exact hostname and action response', async () => {
    result({ success: true, hostname: 'admin.healthidentitydirectory.com', action: 'admin-login', 'error-codes': [] });
    await expect(new TurnstileService().verifyLogin(request)).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith('https://challenges.cloudflare.com/turnstile/v0/siteverify', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body));
    expect(body).toMatchObject({ secret: process.env.TURNSTILE_SECRET_KEY, response: request.token, remoteip: request.remoteIp });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts a recovery action only on its approved hostname', async () => {
    result({ success: true, hostname: 'www.healthidentitydirectory.com', action: 'patient-reset-start' });
    await expect(new TurnstileService().verify({
      token: 'recovery-token', action: 'patient-reset-start',
      origin: 'https://www.healthidentitydirectory.com', remoteIp: '203.0.113.4',
    })).resolves.toBeUndefined();
    await expect(new TurnstileService().verify({
      token: 'recovery-token', action: 'patient-reset-start',
      origin: 'https://admin.healthidentitydirectory.com', remoteIp: '203.0.113.4',
    })).rejects.toMatchObject({ code: 'TURNSTILE_CONTEXT_MISMATCH' });
  });
});
