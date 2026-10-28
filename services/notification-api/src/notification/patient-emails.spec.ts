import { BadRequestException, HttpException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { escapeHtml } from '../providers/email-layout';
import { passwordResetCodeContent, passwordUpdatedContent, patientWelcomeContent } from '../providers/patient-emails';
import { isTemplateOtp, messageContent, type OtpProvider, type ProviderResult } from '../providers/provider.types';
import { DeliverPasswordResetCodeDto, DeliverPasswordUpdatedDto,
  DeliverPatientWelcomeDto } from './dto/deliver-patient-emails.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

// The controller is constructed with an explicit authentication stub; avoid
// loading the ESM-only JWT verifier into the CommonJS test runtime.
jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

const patientId = '6d1f6a0e-5b8c-4f7a-9e3d-2c1b0a9f8e7d';
const challengeId = '0b7e4c2a-9d1f-4e6b-8a3c-5f2d1e0c9b8a';
const welcome = { channel: 'email' as const, recipient: 'ada@example.test', firstName: 'Ada', healthId: 'HID-ABC234' };
const reset = { channel: 'email' as const, recipient: 'ada@example.test', code: '482913', firstName: 'Ada',
  healthId: 'HID-ABC234', expiresInMinutes: 5 };
const updated = { channel: 'email' as const, recipient: 'ada@example.test', firstName: 'Ada', healthId: 'HID-ABC234' };

/** hid-1.0's layout, as every patient email's HTML part carries it. */
const LAYOUT = [
  '<div style="font-family:Arial,sans-serif;background:#f5f7fb;padding:24px;color:#111827">',
  '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">',
  '<div style="font-size:24px;font-weight:700">',
  '<div style="font-size:12px;opacity:0.85;margin-top:4px">Health Identity Directory</div>',
  '<div style="padding:28px">',
  '<p style="margin:0 0 12px;font-size:14px">',
];
const CODE_BOX = '<div style="margin:0 0 18px;padding:18px;border:1px dashed #93c5fd;border-radius:12px;background:#eff6ff;text-align:center">';

describe('Patient emails in hid-1.0\'s design (owner decision of 2026-10-28)', () => {
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
  function controller(email: OtpProvider, others: OtpProvider = provider('termii'), auth?: WorkloadAuthService) {
    const service = new NotificationService({ primary: { email, sms: others, whatsapp: others }, fallback: others });
    return new NotificationController(auth ?? ({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService), service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;

  describe('content', () => {
    it('welcome: "Your Health ID is ready", greeting the patient and showing the Health ID in the blue code box', () => {
      const content = patientWelcomeContent({ firstName: 'Ada', healthId: 'HID-ABC234' });
      expect(content.subject).toBe('Your Health ID is ready');
      expect(content.text).toBe('Hello Ada,\n\n'
        + 'Your Health ID account is ready. Keep your Health ID safe and use it whenever you sign in or share access with a hospital.\n\n'
        + 'Your Health ID: HID-ABC234\n\n'
        + 'You can also sign in with your email address and password, but keep this Health ID available for quick access and hospital verification.');
      for (const piece of LAYOUT) expect(content.html).toContain(piece);
      expect(content.html).toContain('<div style="padding:24px 28px;background:#1a6fd4;color:#ffffff">');
      expect(content.html).toContain('>Welcome to Health ID</div>');
      expect(content.html).toContain('>Hello Ada,</p>');
      expect(content.html).toContain(CODE_BOX);
      expect(content.html).toContain('text-transform:uppercase;margin-bottom:8px">Your Health ID</div>');
      expect(content.html).toContain('<div style="font-size:30px;font-weight:700;letter-spacing:0.12em;color:#1a6fd4">HID-ABC234</div>');
      expect(content.html).toMatch(/^<!doctype html><html lang="en">/);
      expect(content.html).toContain('<title>Your Health ID is ready</title>');
    });

    it('greets "there" without a first name', () => {
      expect(patientWelcomeContent({ healthId: 'HID-ABC234' }).text).toMatch(/^Hello there,\n\n/);
      expect(patientWelcomeContent({ healthId: 'HID-ABC234' }).html).toContain('>Hello there,</p>');
      expect(passwordResetCodeContent({ healthId: 'HID-ABC234', code: '482913', expiresInMinutes: 5 }).text)
        .toMatch(/^Hello there,\n\n/);
      expect(passwordUpdatedContent({ supportEmail: 'support@healthidentitydirectory.com' }).text)
        .toMatch(/^Hello there,\n\n/);
    });

    it('reset code: greets by first name, names the Health ID, the code only in the body', () => {
      const content = passwordResetCodeContent({ firstName: 'Ada', healthId: 'HID-ABC234', code: '482913', expiresInMinutes: 5 });
      expect(content.subject).toBe('Your Health ID password reset code');
      expect(content.subject).not.toContain('482913');
      expect(content.text).toBe('Hello Ada,\n\n'
        + 'A password reset was requested for your Health ID account HID-ABC234. Use the code below to continue.\n\n'
        + 'Verification Code: 482913\n\n'
        + 'This code expires in 5 minutes. If you did not request this reset, ignore this message and consider changing your password after you sign in.');
      for (const piece of LAYOUT) expect(content.html).toContain(piece);
      expect(content.html).toContain('background:#1a6fd4;color:#ffffff">');
      expect(content.html).toContain('>Health ID Security</div>');
      expect(content.html).toContain('<div style="font-size:30px;font-weight:700;letter-spacing:0.24em;color:#1a6fd4">482913</div>');
      expect(passwordResetCodeContent({ healthId: 'HID-ABC234', code: '482913', expiresInMinutes: 1 }).text)
        .toContain('This code expires in 1 minute.');
    });

    it('password updated: the teal "Password Updated" band, the Health ID when sent, and support\'s address', () => {
      const content = passwordUpdatedContent({ firstName: 'Ada', healthId: 'HID-ABC234', supportEmail: 'support@healthidentitydirectory.com' });
      expect(content.subject).toBe('Your Health ID password was updated');
      expect(content.text).toBe('Hello Ada,\n\n'
        + 'The password for Health ID account HID-ABC234 was changed successfully.\n\n'
        + 'If this was not you, contact Health ID support at support@healthidentitydirectory.com immediately and secure your phone and email accounts.');
      for (const piece of LAYOUT) expect(content.html).toContain(piece);
      expect(content.html).toContain('<div style="padding:24px 28px;background:#0f766e;color:#ffffff">');
      expect(content.html).toContain('>Password Updated</div>');
      expect(content.html).not.toContain('dashed');
      expect(passwordUpdatedContent({ supportEmail: 'support@healthidentitydirectory.com' }).text)
        .toContain('The password for your Health ID account was changed successfully.');
    });

    it('escapes every value in the HTML part', () => {
      expect(escapeHtml('<script>alert("x")</script> & \'y\'')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
      const content = patientWelcomeContent({ firstName: '<script>alert(1)</script>', healthId: 'HID-<b>X</b>' });
      expect(content.html).not.toContain('<script>');
      expect(content.html).not.toContain('<b>');
      expect(content.html).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt;,');
      expect(passwordUpdatedContent({ firstName: 'O\'Neil', supportEmail: 'a"b@example.test' }).html)
        .toContain('Hello O&#39;Neil,');
    });

    it('carries no link, no image and no password, and is never a WhatsApp OTP template', () => {
      for (const content of [patientWelcomeContent(welcome), passwordResetCodeContent(reset),
        passwordUpdatedContent({ ...updated, supportEmail: 'support@healthidentitydirectory.com' })]) {
        expect(content.html).not.toMatch(/href=|<img|https?:\/\//i);
        expect(content.text).not.toMatch(/https?:\/\//i);
        const message = { channel: 'email' as const, recipient: 'ada@example.test', code: '', purpose: 'PATIENT_WELCOME',
          idempotencyKey: `patient-welcome:${patientId}`, content };
        expect(isTemplateOtp(message)).toBe(false);
        expect(messageContent(message)).toBe(content);
      }
    });
  });

  describe('routes', () => {
    it('POST patient-welcome renders the welcome and delivers it by email only', async () => {
      const email = provider('ses');
      const sms = provider('termii');
      await expect(controller(email, sms).patientWelcome(welcome, request, `patient-welcome:${patientId}`)).resolves.toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), outcome: 'accepted', primary: { provider: 'ses', outcome: 'accepted' },
      });
      expect(email.send).toHaveBeenCalledWith({ channel: 'email', recipient: 'ada@example.test', code: '',
        purpose: 'PATIENT_WELCOME', idempotencyKey: `patient-welcome:${patientId}`,
        content: patientWelcomeContent({ firstName: 'Ada', healthId: 'HID-ABC234' }) });
      expect(sms.send).not.toHaveBeenCalled();
    });

    it('POST password-reset-code renders the named reset code', async () => {
      const email = provider('ses');
      await controller(email).passwordResetCode(reset, request, `otp:${challengeId}`);
      expect(email.send).toHaveBeenCalledWith({ channel: 'email', recipient: 'ada@example.test', code: '',
        purpose: 'PASSWORD_RESET', idempotencyKey: `otp:${challengeId}`,
        content: passwordResetCodeContent({ firstName: 'Ada', healthId: 'HID-ABC234', code: '482913', expiresInMinutes: 5 }) });
    });

    it('POST password-updated renders the confirmation with the configured support address, with or without a Health ID', async () => {
      Object.assign(process.env, { EMERGENCY_CONTACT_SUPPORT_EMAIL: 'help@example.test' });
      resetEnvironmentForTests();
      const email = provider('ses');
      await controller(email).passwordUpdated(updated, request, `password-updated:${challengeId}`);
      expect((email.send as jest.Mock).mock.calls[0][0]).toEqual({ channel: 'email', recipient: 'ada@example.test', code: '',
        purpose: 'PASSWORD_UPDATED', idempotencyKey: `password-updated:${challengeId}`,
        content: passwordUpdatedContent({ firstName: 'Ada', healthId: 'HID-ABC234', supportEmail: 'help@example.test' }) });
      await controller(email).passwordUpdated({ channel: 'email', recipient: 'staff@example.test' }, request,
        `password-updated:${challengeId}`);
      expect((email.send as jest.Mock).mock.calls[1][0].content)
        .toEqual(passwordUpdatedContent({ supportEmail: 'help@example.test' }));
    });

    it('authenticates the caller before anything else on every route', async () => {
      const email = provider('ses');
      const auth = { authenticate: jest.fn().mockRejectedValue(new UnauthorizedException('Workload authentication failed')) };
      const refused = controller(email, provider('termii'), auth as unknown as WorkloadAuthService);
      await expect(refused.patientWelcome(welcome, request, 'short')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(refused.passwordResetCode(reset, request, 'short')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(refused.passwordUpdated(updated, request, 'short')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(auth.authenticate).toHaveBeenCalledWith('identity-api', 'identity-api', 'identity-api');
      expect(email.send).not.toHaveBeenCalled();
    });

    it('refuses a missing or invalid idempotency key and a recipient that is not an email, before any provider call', async () => {
      const email = provider('ses');
      const routes = controller(email);
      for (const key of [undefined, 'short', ' patient-welcome:0001']) {
        await expect(routes.patientWelcome(welcome, request, key)).rejects.toBeInstanceOf(BadRequestException);
        await expect(routes.passwordResetCode(reset, request, key)).rejects.toBeInstanceOf(BadRequestException);
        await expect(routes.passwordUpdated(updated, request, key)).rejects.toBeInstanceOf(BadRequestException);
      }
      for (const recipient of ['+2348000000000', 'not-an-email', `${'a'.repeat(250)}@example.test`]) {
        await expect(routes.patientWelcome({ ...welcome, recipient }, request, `patient-welcome:${patientId}`))
          .rejects.toBeInstanceOf(BadRequestException);
        await expect(routes.passwordResetCode({ ...reset, recipient }, request, `otp:${challengeId}`))
          .rejects.toBeInstanceOf(BadRequestException);
        await expect(routes.passwordUpdated({ ...updated, recipient }, request, `password-updated:${challengeId}`))
          .rejects.toBeInstanceOf(BadRequestException);
      }
      expect(email.send).not.toHaveBeenCalled();
    });

    it('works under production\'s email-brevo profile, falling back to Brevo after a definitive SES failure', async () => {
      Object.assign(process.env, { NOTIFICATION_DELIVERY_PROFILE: 'email-brevo' });
      resetEnvironmentForTests();
      const email = provider('ses', 'definitive_failure');
      const brevo = provider('brevo');
      await expect(controller(email, brevo).patientWelcome(welcome, request, `patient-welcome:${patientId}`))
        .resolves.toMatchObject({ outcome: 'accepted', primary: { provider: 'ses', outcome: 'definitive_failure' },
          fallback: { provider: 'brevo', outcome: 'accepted' } });
      expect((brevo.send as jest.Mock).mock.calls[0][0]).toMatchObject({ channel: 'email', purpose: 'PATIENT_WELCOME',
        content: { html: expect.stringContaining('Welcome to Health ID') } });
    });

    it('writes no log line with the recipient, the name, the Health ID or the code', async () => {
      Object.assign(process.env, { NOTIFICATION_PROVIDER_MODE: 'live' });
      resetEnvironmentForTests();
      expect(getEnvironment().NOTIFICATION_PROVIDER_MODE).toBe('live');
      const written: string[] = [];
      const capture = (...values: unknown[]) => { written.push(values.map(String).join(' ')); };
      jest.spyOn(console, 'log').mockImplementation(capture);
      jest.spyOn(console, 'warn').mockImplementation(capture);
      jest.spyOn(console, 'error').mockImplementation(capture);
      jest.spyOn(console, 'info').mockImplementation(capture);
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
      jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
      const plan = { capability: 'email', primary: 'ses', fallback: 'brevo', configuration: {} };
      const routes = controller(provider('ses', 'definitive_failure'), provider('brevo'));
      await routes.patientWelcome({ ...welcome, plan }, request, `patient-welcome:${patientId}`);
      await routes.passwordResetCode({ ...reset, plan }, request, `otp:${challengeId}`);
      await routes.passwordUpdated({ ...updated, plan }, request, `password-updated:${challengeId}`);
      jest.restoreAllMocks();
      expect(written.length).toBeGreaterThan(0);
      const log = written.join('\n');
      for (const secret of ['ada@example.test', 'Ada', 'HID-ABC234', '482913', patientId, challengeId]) {
        expect(log).not.toContain(secret);
      }
    });
  });

  // The same options as the application's global pipe (main.ts).
  describe('DTOs', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const cases = [
      ['patient-welcome', DeliverPatientWelcomeDto, welcome],
      ['password-reset-code', DeliverPasswordResetCodeDto, reset],
      ['password-updated', DeliverPasswordUpdatedDto, updated],
    ] as const;

    it.each(cases)('%s accepts its fixed field set, with or without a first name', async (_route, metatype, body) => {
      await expect(pipe.transform({ ...body, plan: { capability: 'email' } }, { type: 'body', metatype }))
        .resolves.toBeInstanceOf(metatype);
      const { firstName: _name, ...withoutName } = body;
      await expect(pipe.transform(withoutName, { type: 'body', metatype })).resolves.toBeInstanceOf(metatype);
      for (const firstName of ['Ọlá', 'Mary-Jane', 'O\'Neil', 'Jean Paul']) {
        await expect(pipe.transform({ ...body, firstName }, { type: 'body', metatype })).resolves.toBeDefined();
      }
    });

    it.each(cases.flatMap(([route, metatype, body]) =>
      ['nin', 'password', 'link', 'url', 'subject', 'text', 'html', 'lastName', 'message'].map((field) => [route, field, metatype, body] as const)))
    ('%s refuses an unknown %s field', async (_route, field, metatype, body) => {
      await expect(pipe.transform({ ...body, [field]: 'x' }, { type: 'body', metatype })).rejects.toBeInstanceOf(BadRequestException);
    });

    const invalid: readonly (readonly [string, string])[] = [
      ['channel', 'sms'], ['channel', 'whatsapp'], ['recipient', 'a'.repeat(321)],
      ['firstName', '<script>'], ['firstName', 'Ada1'], ['firstName', ''], ['firstName', 'A'.repeat(121)],
      ['healthId', 'HID-ABC'], ['healthId', 'HID-ABCIO1'], ['healthId', 'hid-abc234'], ['healthId', 'ABC234'],
    ];
    it.each(cases.flatMap(([route, metatype, body]) =>
      invalid.map(([field, value]) => [route, field, value, metatype, body] as const)))
    ('%s refuses %s %p', async (_route, field, value, metatype, body) => {
      await expect(pipe.transform({ ...body, [field]: value }, { type: 'body', metatype })).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each<[string, unknown]>([['code', '12345'], ['code', '1234567'], ['code', 'abcdef'], ['expiresInMinutes', 0],
      ['expiresInMinutes', 61], ['expiresInMinutes', 2.5], ['expiresInMinutes', '5']])
    ('password-reset-code refuses %s %p', async (field, value) => {
      await expect(pipe.transform({ ...reset, [field]: value }, { type: 'body', metatype: DeliverPasswordResetCodeDto }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      [DeliverPatientWelcomeDto, welcome, ['channel', 'recipient', 'healthId']],
      [DeliverPasswordResetCodeDto, reset, ['channel', 'recipient', 'code', 'healthId', 'expiresInMinutes']],
      [DeliverPasswordUpdatedDto, updated, ['channel', 'recipient']],
    ] as const)('requires its fields (%p)', async (metatype, body, fields) => {
      for (const field of fields) {
        const value: Record<string, unknown> = { ...body };
        delete value[field];
        await expect(pipe.transform(value, { type: 'body', metatype })).rejects.toBeInstanceOf(HttpException);
      }
      if (metatype === DeliverPasswordUpdatedDto) {
        await expect(pipe.transform({ channel: 'email', recipient: 'staff@example.test' }, { type: 'body', metatype }))
          .resolves.toBeDefined();
      }
    });
  });
});
