import { resetEnvironmentForTests } from '../config/environment';
import type { HidRequest } from '../common/request-context';
import { OtpController } from './otp.controller';
import type { OtpService } from './otp.service';
import type { TurnstileService } from './turnstile.service';

const ORIGIN = 'https://www.healthidentitydirectory.com';

/** Each recovery page reaches only its own kind of account (REC-AUDIENCE, 0086). */
describe('OtpController recovery start audience', () => {
  const original = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: ORIGIN,
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it.each([
    ['patient-reset-start', 'patient'],
    ['legacy-recovery', 'patient'],
    ['staff-reset', 'staff'],
    ['admin-reset', 'platform'],
  ] as const)('a %s start asks only for a %s account', async (action, audience) => {
    const start = jest.fn().mockResolvedValue({ accepted: true });
    const verify = jest.fn().mockResolvedValue(undefined);
    const controller = new OtpController({ start } as unknown as OtpService, { verify } as unknown as TurnstileService);
    const request = { header: (name: string) => (name === 'origin' ? ORIGIN : undefined), ip: '192.0.2.1',
      correlationId: 'otp-controller-audience' } as unknown as HidRequest;

    await controller.start({ identifier: 'person@example.test', purpose: 'PASSWORD_RESET',
      turnstileAction: action, turnstileToken: 'token' }, request);

    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ action }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ audience }));
  });
});
