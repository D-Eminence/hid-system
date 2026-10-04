import { Test } from '@nestjs/testing';
import type { OtpProvider, ProviderResult } from '../providers/provider.types';
import { resetEnvironmentForTests } from '../config/environment';
import { NotificationService } from './notification.service';

describe('NotificationService fallback safety', () => {
  const original = { ...process.env };
  beforeEach(() => { Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test' }); resetEnvironmentForTests(); });
  afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); resetEnvironmentForTests(); });
  const message = { channel: 'sms' as const, recipient: '+2348000000000', code: '000001', purpose: 'PASSWORD_RESET', idempotencyKey: 'otp:00000000-0000-4000-8000-000000000001' };
  function provider(name: ProviderResult['provider'], outcome: ProviderResult['outcome']): OtpProvider { return { name, send: jest.fn().mockResolvedValue({ provider: name, outcome }) }; }
  function service(primary: OtpProvider, fallback: OtpProvider) { return new NotificationService({ primary: { email: primary, sms: primary, whatsapp: primary }, fallback }); }

  it('resolves without a provider override in the Nest application container', async () => {
    const module = await Test.createTestingModule({ providers: [NotificationService] }).compile();
    expect(module.get(NotificationService)).toBeInstanceOf(NotificationService);
    await module.close();
  });

  it('uses fallback only after a definitive primary failure', async () => {
    const primary = provider('termii', 'definitive_failure'); const fallback = provider('brevo', 'accepted');
    await expect(service(primary, fallback).deliverOtp(message)).resolves.toMatchObject({ outcome: 'accepted' });
    expect(fallback.send).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate after an unknown primary result', async () => {
    const primary = provider('termii', 'unknown'); const fallback = provider('brevo', 'accepted');
    await expect(service(primary, fallback).deliverOtp(message)).resolves.toMatchObject({ outcome: 'unknown' });
    expect(fallback.send).not.toHaveBeenCalled();
  });
  it('does not call fallback after primary acceptance', async () => {
    const primary = provider('termii', 'accepted'); const fallback = provider('brevo', 'accepted');
    await service(primary, fallback).deliverOtp(message); expect(fallback.send).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'unknown', 'definitive_failure'] as const)
  ('staging email-only preserves the SES %s outcome without attempting fallback', async outcome => {
    Object.assign(process.env, { HID_DEPLOYMENT_ENV: 'staging', NOTIFICATION_DELIVERY_PROFILE: 'email-only' });
    resetEnvironmentForTests();
    const primary = provider('ses', outcome); const fallback = provider('brevo', 'accepted');
    await expect(service(primary, fallback).deliverOtp({ ...message, channel: 'email', recipient: 'patient@example.test' }))
      .resolves.toEqual({ primary: { provider: 'ses', outcome }, outcome });
    expect(primary.send).toHaveBeenCalledTimes(1);
    expect(fallback.send).not.toHaveBeenCalled();
  });

  it.each(['sms', 'whatsapp'] as const)('staging email-only rejects %s before any provider attempt', async channel => {
    Object.assign(process.env, { HID_DEPLOYMENT_ENV: 'staging', NOTIFICATION_DELIVERY_PROFILE: 'email-only' });
    resetEnvironmentForTests();
    const primary = provider('termii', 'accepted'); const fallback = provider('brevo', 'accepted');
    await expect(service(primary, fallback).deliverOtp({ ...message, channel })).rejects.toThrow('supports email OTP only');
    expect(primary.send).not.toHaveBeenCalled();
    expect(fallback.send).not.toHaveBeenCalled();
  });

  it('routes a paused Termii SMS only to the selected Brevo fallback', async () => {
    Object.assign(process.env, { NOTIFICATION_PROVIDER_MODE: 'live' }); resetEnvironmentForTests();
    const unused = provider('termii', 'accepted');
    const selected = provider('brevo', 'accepted');
    await expect(service(unused, selected).deliverOtp(message, {
      capability: 'sms', primary: 'brevo', fallback: null, configuration: { brevo: {} },
    })).resolves.toMatchObject({ outcome: 'accepted', primary: { provider: 'brevo' } });
    expect(unused.send).not.toHaveBeenCalled();
    expect(selected.send).toHaveBeenCalledTimes(1);
  });

  it('requires a policy in live mode and rejects incompatible capability plans', async () => {
    Object.assign(process.env, { NOTIFICATION_PROVIDER_MODE: 'live' }); resetEnvironmentForTests();
    const first = provider('termii', 'accepted'); const fallback = provider('brevo', 'accepted');
    await expect(service(first, fallback).deliverOtp(message)).rejects.toThrow('Delivery policy is unavailable');
    await expect(service(first, fallback).deliverOtp(message, {
      capability: 'sms', primary: 'ses', fallback: null, configuration: { ses: {} },
    })).rejects.toThrow('Invalid delivery policy');
    expect(first.send).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'unknown', 'definitive_failure'] as const)
  ('email-SMS profile preserves safe fallback behavior for %s', async outcome => {
    Object.assign(process.env, { NOTIFICATION_DELIVERY_PROFILE: 'email-sms-brevo' }); resetEnvironmentForTests();
    const primary = provider('termii', outcome), fallback = provider('brevo', 'accepted');
    await service(primary, fallback).deliverOtp(message);
    expect(fallback.send).toHaveBeenCalledTimes(outcome === 'definitive_failure' ? 1 : 0);
  });

  it('email-SMS profile rejects WhatsApp before selecting a provider', async () => {
    Object.assign(process.env, { NOTIFICATION_DELIVERY_PROFILE: 'email-sms-brevo' }); resetEnvironmentForTests();
    const primary = provider('termii', 'accepted'), fallback = provider('brevo', 'accepted');
    await expect(service(primary, fallback).deliverOtp({ ...message, channel: 'whatsapp' }))
      .rejects.toThrow('does not support WhatsApp');
    expect(primary.send).not.toHaveBeenCalled(); expect(fallback.send).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'unknown', 'definitive_failure'] as const)
  ('staging email-brevo only falls back after definitive failure (%s)', async outcome => {
    Object.assign(process.env, { HID_DEPLOYMENT_ENV: 'staging', NOTIFICATION_DELIVERY_PROFILE: 'email-brevo',
      NOTIFICATION_PROVIDER_MODE: 'live' }); resetEnvironmentForTests();
    const first = provider('ses', outcome); const fallback = provider('brevo', 'accepted');
    const result = await service(first, fallback).deliverOtp({ ...message, channel: 'email', recipient: 'patient@example.test' }, {
      capability: 'email', primary: 'ses', fallback: 'brevo', configuration: {},
    });
    expect(result.outcome).toBe(outcome === 'definitive_failure' ? 'accepted' : outcome);
    expect(fallback.send).toHaveBeenCalledTimes(outcome === 'definitive_failure' ? 1 : 0);
  });

  it.each(['sms', 'whatsapp'] as const)('staging email-brevo rejects %s without sending', async channel => {
    Object.assign(process.env, { HID_DEPLOYMENT_ENV: 'staging', NOTIFICATION_DELIVERY_PROFILE: 'email-brevo' });
    resetEnvironmentForTests();
    const first = provider('ses', 'accepted'); const fallback = provider('brevo', 'accepted');
    await expect(service(first, fallback).deliverOtp({ ...message, channel })).rejects.toThrow('supports email OTP only');
    expect(first.send).not.toHaveBeenCalled(); expect(fallback.send).not.toHaveBeenCalled();
  });
});
