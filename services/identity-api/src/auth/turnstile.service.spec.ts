import { Logger } from '@nestjs/common';
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
      HID_DEPLOYMENT_ENV: 'production',
      // Official Cloudflare always-pass test secret; fetch is still mocked.
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', TURNSTILE_TIMEOUT_MS: '250',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    global.fetch = originalFetch;
    jest.restoreAllMocks();
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

  it('accepts patient enrollment only on the public website for the active deployment', async () => {
    result({ success: true, hostname: 'www.healthidentitydirectory.com', action: 'patient-enrollment' });
    await expect(new TurnstileService().verify({
      token: 'enrollment-token', action: 'patient-enrollment',
      origin: 'https://www.healthidentitydirectory.com', remoteIp: '203.0.113.4',
    })).resolves.toBeUndefined();
    await expect(new TurnstileService().verify({
      token: 'enrollment-token', action: 'patient-enrollment',
      origin: 'https://admin.healthidentitydirectory.com', remoteIp: '203.0.113.4',
    })).rejects.toMatchObject({ code: 'TURNSTILE_CONTEXT_MISMATCH' });

    process.env.HID_DEPLOYMENT_ENV = 'staging';
    resetEnvironmentForTests();
    result({ success: true, hostname: 'staging.healthidentitydirectory.com', action: 'patient-enrollment' });
    await expect(new TurnstileService().verify({
      token: 'staging-enrollment-token', action: 'patient-enrollment',
      origin: 'https://staging.healthidentitydirectory.com', remoteIp: '203.0.113.4',
    })).resolves.toBeUndefined();
  });

  it('answers a missing, empty or oversized token, Origin or action before calling Cloudflare', async () => {
    global.fetch = jest.fn();
    const service = new TurnstileService();
    for (const input of [{ ...request, token: undefined }, { ...request, token: '   ' }, { ...request, token: 'x'.repeat(2049) },
      { ...request, origin: undefined }, { ...request, action: undefined }]) {
      await expect(service.verify(input)).rejects.toMatchObject({ code: 'TURNSTILE_REQUIRED', status: 400 });
    }
    await expect(service.verify({ ...request, origin: 'https://lab.healthidentitydirectory.com' }))
      .rejects.toMatchObject({ code: 'TURNSTILE_CONTEXT_MISMATCH', status: 403 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // The production profile refuses to start with Turnstile disabled or without
  // its secret (TS-10), so these two run the staging profile locally.
  it('accepts anything without calling Cloudflare only when Turnstile is disabled', async () => {
    process.env.HID_DEPLOYMENT_ENV = 'staging';
    process.env.TURNSTILE_MODE = 'disabled';
    resetEnvironmentForTests();
    global.fetch = jest.fn();
    await expect(new TurnstileService().verify({})).resolves.toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('answers 503 without calling Cloudflare when the secret is missing', async () => {
    process.env.HID_DEPLOYMENT_ENV = 'staging';
    process.env.TURNSTILE_SECRET_KEY = '';
    resetEnvironmentForTests();
    global.fetch = jest.fn();
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE', status: 503 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('answers 503, not a rejection of the user, when Siteverify refuses the server configuration (TS-3)', async () => {
    for (const code of ['invalid-input-secret', 'missing-input-secret', 'internal-error']) {
      result({ success: false, 'error-codes': [code] });
      await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE', status: 503 });
    }
    result({ success: false, 'error-codes': ['invalid-input-response'] });
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_REJECTED', status: 403 });
  });

  // Cloudflare answers a wrong, missing or malformed secret with HTTP 400 and a
  // JSON body naming the code; the visitor's own token errors come with HTTP 200.
  it('reads the codes of a 4xx Siteverify answer and logs it as a configuration refusal at error level', async () => {
    const errors: string[] = [];
    const warnings: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => { errors.push(String(message)); });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)); });
    for (const code of ['invalid-input-secret', 'missing-input-secret', 'bad-request']) {
      result({ success: false, 'error-codes': [code] }, 400);
      await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE', status: 503 });
    }
    result({ success: false, 'error-codes': ['bad-request'] });
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE', status: 503 });
    expect(warnings).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/reason=siteverify_refused_configuration codes=invalid-input-secret attempts=1/);
    expect(errors[2]).toMatch(/reason=siteverify_refused_configuration codes=bad-request attempts=1/);
    expect(errors[3]).toMatch(/reason=siteverify_refused_configuration codes=bad-request attempts=1/);
  });

  it('releases the body of a 5xx answer before retrying', async () => {
    const failed = new Response('{"success":false}', { status: 503 });
    global.fetch = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, hostname: 'admin.healthidentitydirectory.com', action: 'admin-login' })));
    await expect(new TurnstileService().verify(request)).resolves.toBeUndefined();
    expect(failed.bodyUsed).toBe(true);
  });

  it('answers 503 for a non-2xx or unreadable Siteverify answer', async () => {
    result({ success: false }, 400);
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE', status: 503 });
    global.fetch = jest.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE', status: 503 });
  });

  it('logs each refusal and outage with the action and Cloudflare codes, never the token, secret or address (TS-3)', async () => {
    const lines: string[] = [];
    const capture = (message: unknown) => { lines.push(String(message)); };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    result({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_EXPIRED_OR_REPLAYED' });
    result({ success: false, 'error-codes': ['invalid-input-secret'] });
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/event=turnstile_verification outcome=TURNSTILE_EXPIRED_OR_REPLAYED action=admin-login .*codes=timeout-or-duplicate/);
    expect(lines[1]).toMatch(/outcome=TURNSTILE_UNAVAILABLE .*reason=siteverify_refused_configuration .*codes=invalid-input-secret/);
    expect(lines[2]).toMatch(/outcome=TURNSTILE_UNAVAILABLE .*reason=siteverify_unreachable .*attempts=2/);
    for (const line of lines) {
      expect(line).not.toContain(request.token);
      expect(line).not.toContain(process.env.TURNSTILE_SECRET_KEY);
      expect(line).not.toContain(request.remoteIp);
    }
  });

  it('retries one transport failure or 5xx with the same idempotency key, and never a refusal (TS-2)', async () => {
    const ok = () => new Response(JSON.stringify({ success: true, hostname: 'admin.healthidentitydirectory.com', action: 'admin-login' }));
    const keys = (mock: jest.Mock) => mock.mock.calls.map((call) => JSON.parse(String(call[1].body)).idempotency_key);

    global.fetch = jest.fn().mockRejectedValueOnce(new DOMException('timed out', 'AbortError')).mockResolvedValueOnce(ok());
    await expect(new TurnstileService().verify(request)).resolves.toBeUndefined();
    const timedOut = keys(global.fetch as jest.Mock);
    expect(timedOut).toHaveLength(2);
    expect(timedOut[1]).toBe(timedOut[0]);

    global.fetch = jest.fn().mockResolvedValueOnce(new Response('{}', { status: 502 })).mockResolvedValueOnce(ok());
    await expect(new TurnstileService().verify(request)).resolves.toBeUndefined();
    expect(keys(global.fetch as jest.Mock)).toHaveLength(2);

    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(new TurnstileService().verify(request)).rejects.toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
    expect(global.fetch).toHaveBeenCalledTimes(2);

    for (const answer of [new Response('{}', { status: 400 }),
      new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }))]) {
      global.fetch = jest.fn().mockResolvedValue(answer);
      await expect(new TurnstileService().verify(request)).rejects.toBeDefined();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }

    // A new verification, even of the same token, never reuses another one's key.
    global.fetch = jest.fn().mockImplementation(async () => ok());
    const service = new TurnstileService();
    await service.verify(request);
    await service.verify(request);
    const separate = keys(global.fetch as jest.Mock);
    expect(separate[1]).not.toBe(separate[0]);
  });

  it('accepts the preserved OCR login action only on the Migrate hostname', async () => {
    result({ success: true, hostname: 'migrate.healthidentitydirectory.com', action: 'ocr-login' });
    await expect(new TurnstileService().verifyLogin({
      token: 'migrate-token', action: 'ocr-login', origin: 'https://migrate.healthidentitydirectory.com',
    })).resolves.toBeUndefined();
    result({ success: true, hostname: 'ocr.healthidentitydirectory.com', action: 'ocr-login' });
    await expect(new TurnstileService().verifyLogin({
      token: 'legacy-ocr-token', action: 'ocr-login', origin: 'https://ocr.healthidentitydirectory.com',
    })).rejects.toMatchObject({ code: 'TURNSTILE_CONTEXT_MISMATCH' });
  });

  it('accepts only staging evidence under the staging deployment profile', async () => {
    process.env.HID_DEPLOYMENT_ENV = 'staging';
    resetEnvironmentForTests();
    result({ success: true, hostname: 'admin.staging.healthidentitydirectory.com', action: 'admin-login' });
    await expect(new TurnstileService().verifyLogin({
      token: 'staging-token', action: 'admin-login', origin: 'https://admin.staging.healthidentitydirectory.com',
    })).resolves.toBeUndefined();

    result({ success: true, hostname: 'admin.healthidentitydirectory.com', action: 'admin-login' });
    await expect(new TurnstileService().verifyLogin({
      token: 'production-token', action: 'admin-login', origin: 'https://admin.healthidentitydirectory.com',
    })).rejects.toMatchObject({ code: 'TURNSTILE_CONTEXT_MISMATCH' });
  });
});
