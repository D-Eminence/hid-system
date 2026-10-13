import { resetEnvironmentForTests } from '../config/environment';
import type { OtpProvider, ProviderResult } from '../providers/provider.types';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

// The controller's workload authentication is replaced by a stub below; its
// ESM-only JWT library is not loaded here.
jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

// D4 and NOTIF-PROD: one PHI-free `notification.otp.outcome` line per OTP send,
// which the CloudWatch metric filter counts and the alarm watches.
describe('notification.otp.outcome', () => {
  const original = { ...process.env };
  const recipient = '+2348012345678';
  const code = '492817';
  const idempotencyKey = 'otp:00000000-0000-4000-8000-0000000000aa';
  const message = { channel: 'sms' as const, recipient, code, purpose: 'SIGNUP_VERIFY', idempotencyKey };
  let lines: string[];
  let write: jest.SpyInstance;

  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test' });
    // Hermetic: a runner's own provider or static AWS settings must not leak in.
    for (const key of Object.keys(process.env)) {
      if (/^(AWS_|META_|BREVO_|TERMII_|SES_|NOTIFICATION_IDENTITY_)/.test(key)) delete process.env[key];
    }
    delete process.env.NOTIFICATION_DELIVERY_PROFILE;
    delete process.env.HID_DEPLOYMENT_ENV;
    resetEnvironmentForTests();
    lines = [];
    write = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });
  afterEach(() => {
    write.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function provider(name: ProviderResult['provider'], result: Omit<ProviderResult, 'provider'>): OtpProvider {
    return { name, send: jest.fn().mockResolvedValue({ provider: name, ...result }) };
  }
  function service(primary: OtpProvider, fallback: OtpProvider) {
    return new NotificationService({ primary: { email: primary, sms: primary, whatsapp: primary }, fallback });
  }
  function events(): Array<Record<string, unknown>> {
    return lines.flatMap(line => line.split('\n')).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(event => event.event === 'notification.otp.outcome');
  }
  function assertPhiFree(): void {
    const text = lines.join('');
    for (const value of [recipient, recipient.slice(1), code, idempotencyKey, 'verification code', 'patient@example.test']) {
      expect(text).not.toContain(value);
    }
  }

  it.each([
    ['accepted', 'accepted'],
    ['unknown', 'retryable_failure'],
  ] as const)('logs one %s primary result as %s without recipient, code or text', async (result, outcome) => {
    await service(provider('termii', { outcome: result, safeCode: result === 'unknown' ? 'http_503' : undefined }),
      provider('brevo', { outcome: 'accepted' })).deliverOtp(message);
    expect(events()).toEqual([{
      event: 'notification.otp.outcome', channel: 'sms', purpose: 'SIGNUP_VERIFY', outcome, provider: 'termii',
      fallbackUsed: false, correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      ...(result === 'unknown' ? { safeCode: 'http_503' } : {}),
    }]);
    assertPhiFree();
  });

  it('reports the fallback provider and a definitive failure when both providers refuse', async () => {
    await service(provider('termii', { outcome: 'definitive_failure', safeCode: 'http_400' }),
      provider('brevo', { outcome: 'definitive_failure', safeCode: 'not_configured' })).deliverOtp(message);
    expect(events()).toEqual([expect.objectContaining({
      outcome: 'definitive_failure', provider: 'brevo', fallbackUsed: true, safeCode: 'not_configured',
    })]);
    assertPhiFree();
  });

  // An unconfigured fallback (production injects no Brevo field) must not hide
  // why the primary failed: the line also names the primary and its code.
  it.each([
    ['sms', 'termii', 'http_401'],
    ['email', 'ses', 'SendingPausedException'],
  ] as const)('keeps the %s primary %s and its code %s when the fallback answers not_configured', async (channel, name, safeCode) => {
    await service(provider(name, { outcome: 'definitive_failure', safeCode }),
      provider('brevo', { outcome: 'definitive_failure', safeCode: 'not_configured' }))
      .deliverOtp({ ...message, channel, recipient: channel === 'email' ? 'patient@example.test' : recipient });
    expect(events()).toEqual([{
      event: 'notification.otp.outcome', channel, purpose: 'SIGNUP_VERIFY', outcome: 'definitive_failure',
      provider: 'brevo', fallbackUsed: true, correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      safeCode: 'not_configured', primaryProvider: name, primarySafeCode: safeCode,
    }]);
    assertPhiFree();
  });

  it('reports an accepted fallback after a definitive primary failure', async () => {
    await service(provider('ses', { outcome: 'definitive_failure', safeCode: 'MessageRejected' }),
      provider('brevo', { outcome: 'accepted', providerMessageId: 'provider-message-id-1' }))
      .deliverOtp({ ...message, channel: 'email', recipient: 'patient@example.test' });
    expect(events()).toEqual([expect.objectContaining({ channel: 'email', outcome: 'accepted', provider: 'brevo', fallbackUsed: true,
      primaryProvider: 'ses', primarySafeCode: 'MessageRejected' })]);
    expect(lines.join('')).not.toContain('provider-message-id-1');
    assertPhiFree();
  });

  it('never logs an unclassified primary code next to a fallback', async () => {
    await service(provider('termii', { outcome: 'definitive_failure', safeCode: 'Invalid number +2348012345678' }),
      provider('brevo', { outcome: 'accepted' })).deliverOtp(message);
    expect(events()).toEqual([expect.objectContaining({ provider: 'brevo', fallbackUsed: true, primaryProvider: 'termii' })]);
    expect(events()[0]).not.toHaveProperty('primarySafeCode');
    assertPhiFree();
  });

  it('never logs an unclassified provider code', async () => {
    await service(provider('ses', { outcome: 'unknown', safeCode: 'Recipient patient@example.test rejected' }),
      provider('brevo', { outcome: 'accepted' }))
      .deliverOtp({ ...message, channel: 'email', recipient: 'patient@example.test' });
    expect(events()).toEqual([expect.objectContaining({ outcome: 'retryable_failure', provider: 'ses' })]);
    expect(events()[0]).not.toHaveProperty('safeCode');
    assertPhiFree();
  });

  it('logs a refused send as a definitive failure without a provider attempt', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'production', NOTIFICATION_PROVIDER_MODE: 'live',
      NOTIFICATION_DELIVERY_PROFILE: 'otp-email-sms', NOTIFICATION_WORKLOAD_IDENTITY_MODE: 'jwt',
      WORKLOAD_ISSUER_URL: 'https://issuer.example.test', WORKLOAD_JWKS_URL: 'https://issuer.example.test/jwks.json',
      IDENTITY_CALLER_SUBJECT: 'hid:production:identity-api', AWS_REGION: 'eu-west-1', SES_FROM_ADDRESS: 'security@example.test',
      TERMII_BASE_URL: 'https://termii.example.test', TERMII_API_KEY: 'synthetic-termii-key', TERMII_SENDER_ID: 'HID' });
    resetEnvironmentForTests();
    const primary = provider('meta-whatsapp', { outcome: 'accepted' });
    const fallback = provider('brevo', { outcome: 'accepted' });
    await expect(service(primary, fallback).deliverOtp({ ...message, channel: 'whatsapp' })).rejects.toThrow('email and SMS OTP only');
    expect(primary.send).not.toHaveBeenCalled();
    expect(fallback.send).not.toHaveBeenCalled();
    expect(events()).toEqual([expect.objectContaining({
      channel: 'whatsapp', outcome: 'definitive_failure', provider: 'none', fallbackUsed: false, safeCode: 'refused',
    })]);
    assertPhiFree();
  });

  it('does not log an OTP outcome for an emergency-contact alert', async () => {
    await service(provider('termii', { outcome: 'accepted' }), provider('brevo', { outcome: 'accepted' })).deliverEmergencyContactAlert({
      channel: 'sms', recipient, patientFirstName: 'Ada', facilityName: null, occurredAt: new Date('2026-10-13T08:00:00Z'), idempotencyKey,
    });
    expect(events()).toEqual([]);
  });

  it('uses the response requestId as the correlation id', async () => {
    const notifications = service(provider('termii', { outcome: 'accepted' }), provider('brevo', { outcome: 'accepted' }));
    const controller = new NotificationController({ authenticate: jest.fn().mockResolvedValue('hid:test:identity-api') } as never,
      notifications);
    const response = await controller.otp({ channel: 'sms', recipient, code, purpose: 'SIGNUP_VERIFY' } as never,
      { header: () => undefined } as never, idempotencyKey);
    expect(events()).toEqual([expect.objectContaining({ correlationId: response.requestId })]);
    assertPhiFree();
  });
});
