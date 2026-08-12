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

  it('uses fallback only after a definitive primary failure', async () => {
    const primary = provider('termii', 'definitive_failure'); const fallback = provider('infobip', 'accepted');
    await expect(service(primary, fallback).deliverOtp(message)).resolves.toMatchObject({ outcome: 'accepted' });
    expect(fallback.send).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate after an unknown primary result', async () => {
    const primary = provider('termii', 'unknown'); const fallback = provider('infobip', 'accepted');
    await expect(service(primary, fallback).deliverOtp(message)).resolves.toMatchObject({ outcome: 'unknown' });
    expect(fallback.send).not.toHaveBeenCalled();
  });
  it('does not call fallback after primary acceptance', async () => {
    const primary = provider('termii', 'accepted'); const fallback = provider('infobip', 'accepted');
    await service(primary, fallback).deliverOtp(message); expect(fallback.send).not.toHaveBeenCalled();
  });
});
