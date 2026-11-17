import { BadRequestException, HttpException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { passwordResetCodeContent, staffPasswordResetCodeContent } from '../providers/patient-emails';
import { isTemplateOtp, messageContent, type OtpProvider, type ProviderResult } from '../providers/provider.types';
import { DeliverStaffPasswordResetCodeDto } from './dto/deliver-patient-emails.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

// Owner decision of 17 November 2026 (Q89): a staff account's password reset
// code in the patient reset code's layout, greeting the staff member by first
// name, with no Health ID.

const challengeId = '0b7e4c2a-9d1f-4e6b-8a3c-5f2d1e0c9b8a';
const staffReset = { channel: 'email' as const, recipient: 'ada@example.test', code: '482913', firstName: 'Ada',
  expiresInMinutes: 5 };

const LAYOUT = [
  '<div style="font-family:Arial,sans-serif;background:#f5f7fb;padding:24px;color:#111827">',
  '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">',
  '<div style="font-size:12px;opacity:0.85;margin-top:4px">Health Identity Directory</div>',
  '<div style="margin:0 0 18px;padding:18px;border:1px dashed #93c5fd;border-radius:12px;background:#eff6ff;text-align:center">',
];

describe('The staff password reset code email (Q89)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test', HID_DEPLOYMENT_ENV: 'production' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
    jest.restoreAllMocks();
  });

  function provider(name: ProviderResult['provider'], outcome: ProviderResult['outcome'] = 'accepted'): OtpProvider {
    return { name, send: jest.fn().mockResolvedValue({ provider: name, outcome } satisfies ProviderResult) };
  }
  function controller(email: OtpProvider, auth?: WorkloadAuthService) {
    const others = provider('termii');
    const service = new NotificationService({ primary: { email, sms: others, whatsapp: others }, fallback: others });
    return new NotificationController(auth ?? ({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService), service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;

  describe('content', () => {
    it('the patient code\'s subject, header, code box and expiry, the staff body, and no Health ID', () => {
      const content = staffPasswordResetCodeContent({ firstName: 'Ada', code: '482913', expiresInMinutes: 5 });
      expect(content.subject).toBe('Your Health ID password reset code');
      expect(content.subject).not.toContain('482913');
      expect(content.text).toBe('Hello Ada,\n\n'
        + 'A password reset was requested for your Health ID staff account. Use the code below to continue.\n\n'
        + 'Verification Code: 482913\n\n'
        + 'This code expires in 5 minutes. If you did not request this reset, ignore this message and consider changing your password after you sign in.');
      for (const piece of LAYOUT) expect(content.html).toContain(piece);
      expect(content.html).toContain('<div style="padding:24px 28px;background:#1a6fd4;color:#ffffff">');
      expect(content.html).toContain('>Health ID Security</div>');
      expect(content.html).toContain('>Hello Ada,</p>');
      expect(content.html).toContain('text-transform:uppercase;margin-bottom:8px">Verification Code</div>');
      expect(content.html).toContain('<div style="font-size:30px;font-weight:700;letter-spacing:0.24em;color:#1a6fd4">482913</div>');
      expect(content.html).toContain('<title>Your Health ID password reset code</title>');
      expect(content.html).not.toMatch(/HID-|href=|<img|https?:\/\//i);
    });

    it('is the patient code email with only the greeting and the account sentence changed', () => {
      const staff = staffPasswordResetCodeContent({ firstName: 'Ada', code: '482913', expiresInMinutes: 5 });
      const patient = passwordResetCodeContent({ firstName: 'Ada', healthId: 'HID-ABC234', code: '482913', expiresInMinutes: 5 });
      expect(String(staff.html).replace('your Health ID staff account.', 'X'))
        .toBe(String(patient.html).replace('your Health ID account HID-ABC234.', 'X'));
    });

    it('greets "there" without a first name, and counts minutes', () => {
      const content = staffPasswordResetCodeContent({ code: '482913', expiresInMinutes: 1 });
      expect(content.text).toMatch(/^Hello there,\n\n/);
      expect(content.html).toContain('>Hello there,</p>');
      expect(content.text).toContain('This code expires in 1 minute.');
      expect(staffPasswordResetCodeContent({ code: '482913', expiresInMinutes: 10 }).text)
        .toContain('This code expires in 10 minutes.');
    });

    it('escapes the name in the HTML part', () => {
      expect(staffPasswordResetCodeContent({ firstName: '<b>Ada</b>', code: '482913', expiresInMinutes: 5 }).html)
        .toContain('Hello &lt;b&gt;Ada&lt;/b&gt;,');
    });

    it('is never a WhatsApp OTP template', () => {
      const content = staffPasswordResetCodeContent(staffReset);
      const message = { channel: 'email' as const, recipient: 'ada@example.test', code: '', purpose: 'PASSWORD_RESET',
        idempotencyKey: `otp:${challengeId}`, content };
      expect(isTemplateOtp(message)).toBe(false);
      expect(messageContent(message)).toEqual(content);
    });
  });

  describe('POST /api/v1/notifications/staff-password-reset-code', () => {
    it('renders the staff reset code by email under the caller\'s key', async () => {
      const email = provider('ses');
      await expect(controller(email).staffPasswordResetCode(staffReset, request, `otp:${challengeId}`))
        .resolves.toMatchObject({ outcome: 'accepted', primary: { provider: 'ses', outcome: 'accepted' } });
      expect(email.send).toHaveBeenCalledWith({ channel: 'email', recipient: 'ada@example.test', code: '',
        purpose: 'PASSWORD_RESET', idempotencyKey: `otp:${challengeId}`,
        content: staffPasswordResetCodeContent({ firstName: 'Ada', code: '482913', expiresInMinutes: 5 }) });
    });

    it('renders "Hello there," when Identity sends no first name', async () => {
      const email = provider('ses');
      const { firstName: _omitted, ...nameless } = staffReset;
      await controller(email).staffPasswordResetCode(nameless, request, `otp:${challengeId}`);
      expect((email.send as jest.Mock).mock.calls[0][0].content)
        .toEqual(staffPasswordResetCodeContent({ code: '482913', expiresInMinutes: 5 }));
    });

    it('authenticates the caller first', async () => {
      const email = provider('ses');
      const auth = { authenticate: jest.fn().mockRejectedValue(new UnauthorizedException('Workload authentication failed')) };
      await expect(controller(email, auth as unknown as WorkloadAuthService)
        .staffPasswordResetCode(staffReset, request, 'short')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(email.send).not.toHaveBeenCalled();
    });

    it('refuses a missing or invalid idempotency key and a recipient that is not an email', async () => {
      const email = provider('ses');
      const routes = controller(email);
      for (const key of [undefined, 'short', ' otp:0001']) {
        await expect(routes.staffPasswordResetCode(staffReset, request, key)).rejects.toBeInstanceOf(BadRequestException);
      }
      for (const recipient of ['+2348000000000', 'not-an-email']) {
        await expect(routes.staffPasswordResetCode({ ...staffReset, recipient }, request, `otp:${challengeId}`))
          .rejects.toBeInstanceOf(BadRequestException);
      }
      expect(email.send).not.toHaveBeenCalled();
    });
  });

  describe('DTO (the application\'s global pipe)', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const metatype = DeliverStaffPasswordResetCodeDto;

    it('accepts its fixed field set, with or without a first name', async () => {
      await expect(pipe.transform({ ...staffReset, plan: { capability: 'email' } }, { type: 'body', metatype }))
        .resolves.toBeInstanceOf(metatype);
      const { firstName: _omitted, ...nameless } = staffReset;
      await expect(pipe.transform(nameless, { type: 'body', metatype })).resolves.toBeInstanceOf(metatype);
    });

    it.each(['healthId', 'nin', 'password', 'link', 'subject', 'text', 'html', 'message', 'purpose'])(
      'refuses an unknown %s field', async (field) => {
        await expect(pipe.transform({ ...staffReset, [field]: 'x' }, { type: 'body', metatype }))
          .rejects.toBeInstanceOf(BadRequestException);
      });

    it.each<[string, unknown]>([['channel', 'sms'], ['recipient', 'a'.repeat(321)], ['firstName', '<script>'],
      ['firstName', 'Ada1'], ['firstName', ''], ['code', '12345'], ['code', 'abcdef'], ['expiresInMinutes', 0],
      ['expiresInMinutes', 61], ['expiresInMinutes', 2.5], ['expiresInMinutes', '5']])('refuses %s %p', async (field, value) => {
      await expect(pipe.transform({ ...staffReset, [field]: value }, { type: 'body', metatype }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it.each(['channel', 'recipient', 'code', 'expiresInMinutes'])('requires %s', async (field) => {
      const value: Record<string, unknown> = { ...staffReset };
      delete value[field];
      await expect(pipe.transform(value, { type: 'body', metatype })).rejects.toBeInstanceOf(HttpException);
    });
  });
});
