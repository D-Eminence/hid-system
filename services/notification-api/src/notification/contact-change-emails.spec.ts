import { BadRequestException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { contactChangedContent, emailChangeCodeContent } from '../providers/patient-emails';
import { isTemplateOtp, messageContent, type OtpProvider, type ProviderResult } from '../providers/provider.types';
import { DeliverContactChangedDto, DeliverEmailChangeCodeDto, MASKED_CONTACT } from './dto/deliver-patient-emails.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

const changeId = '3c0e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d';
const code = { channel: 'email' as const, recipient: 'new@example.test', code: '482913', expiresInMinutes: 5 };
const notice = { channel: 'email' as const, recipient: 'old@example.test', kind: 'email' as const,
  newContactHint: 'n•••@example.test', firstName: 'Ada', healthId: 'HID-ABC234' };

describe('Contact-change emails (0094)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test', HID_DEPLOYMENT_ENV: 'production',
      EMERGENCY_CONTACT_SUPPORT_EMAIL: 'support@healthidentitydirectory.com' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function provider(name: ProviderResult['provider']): OtpProvider {
    return { name, send: jest.fn().mockResolvedValue({ provider: name, outcome: 'accepted' } satisfies ProviderResult) };
  }
  function controller(email: OtpProvider, auth?: WorkloadAuthService) {
    const others = provider('termii');
    const service = new NotificationService({ primary: { email, sms: others, whatsapp: others }, fallback: others });
    return new NotificationController(auth ?? ({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService), service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;

  it('the new address\'s code: blue band, the code only in the body, naming neither the patient nor the Health ID', () => {
    const content = emailChangeCodeContent({ code: '482913', expiresInMinutes: 5 });
    expect(content.subject).toBe('Confirm your new Health ID email address');
    expect(content.text).toBe('Hello there,\n\n'
      + 'Use the code below to make this address the email for a Health ID account.\n\n'
      + 'Verification Code: 482913\n\n'
      + 'This code expires in 5 minutes. If you did not ask for this, ignore this email; nothing changes on the account.');
    expect(content.html).toContain('background:#1a6fd4;color:#ffffff">');
    expect(content.html).toContain('>Confirm your email</div>');
    expect(content.html).toContain('letter-spacing:0.24em;color:#1a6fd4">482913</div>');
    expect(`${content.text}${content.html}`).not.toMatch(/HID-|Ada/);
    expect(emailChangeCodeContent({ code: '482913', expiresInMinutes: 1 }).text).toContain('expires in 1 minute.');
  });

  it('the notices: "Your Health ID email was changed" and "... phone number was changed", teal, the new contact masked', () => {
    const email = contactChangedContent({ ...notice, supportEmail: 'support@healthidentitydirectory.com' });
    expect(email.subject).toBe('Your Health ID email was changed');
    expect(email.text).toBe('Hello Ada,\n\n'
      + 'The email address for Health ID account HID-ABC234 was changed to n•••@example.test. '
      + 'This address will no longer be used to sign in or reset the password.\n\n'
      + 'If this was not you, contact Health ID support at support@healthidentitydirectory.com immediately and secure '
      + 'your phone and email accounts.');
    expect(email.html).toContain('<div style="padding:24px 28px;background:#0f766e;color:#ffffff">');
    expect(email.html).toContain('>Email Changed</div>');
    const phone = contactChangedContent({ kind: 'phone', newContactHint: '+234•••••567',
      supportEmail: 'support@healthidentitydirectory.com' });
    expect(phone.subject).toBe('Your Health ID phone number was changed');
    expect(phone.text).toMatch(/^Hello there,\n\nThe phone number for your Health ID account was changed to \+234•••••567\.\n\n/);
    expect(phone.html).toContain('>Phone Number Changed</div>');
    for (const content of [email, phone]) {
      expect(content.html).not.toMatch(/href=|<img|https?:\/\//i);
      expect(isTemplateOtp({ channel: 'email', recipient: 'a@example.test', code: '', purpose: 'CONTACT_CHANGED',
        idempotencyKey: 'contact-changed:x', content })).toBe(false);
      expect(messageContent({ channel: 'email', recipient: 'a@example.test', code: '', purpose: 'CONTACT_CHANGED',
        idempotencyKey: 'contact-changed:x', content })).toBe(content);
    }
  });

  it('POST email-change-code and POST contact-changed render their email and send it by email only', async () => {
    const email = provider('ses');
    await expect(controller(email).emailChangeCode(code, request, `contact-change:${changeId}`)).resolves.toMatchObject({
      outcome: 'accepted', primary: { provider: 'ses', outcome: 'accepted' } });
    expect(email.send).toHaveBeenCalledWith({ channel: 'email', recipient: 'new@example.test', code: '',
      purpose: 'EMAIL_VERIFY', idempotencyKey: `contact-change:${changeId}`,
      content: emailChangeCodeContent({ code: '482913', expiresInMinutes: 5 }) });
    await controller(email).contactChanged(notice, request, `contact-changed:${changeId}`);
    expect((email.send as jest.Mock).mock.calls[1][0]).toEqual({ channel: 'email', recipient: 'old@example.test', code: '',
      purpose: 'CONTACT_CHANGED', idempotencyKey: `contact-changed:${changeId}`,
      content: contactChangedContent({ ...notice, supportEmail: 'support@healthidentitydirectory.com' }) });
  });

  it('authenticates first, then needs an idempotency key and an email recipient', async () => {
    const email = provider('ses');
    const auth = { authenticate: jest.fn().mockRejectedValue(new UnauthorizedException('Workload authentication failed')) };
    await expect(controller(email, auth as unknown as WorkloadAuthService).contactChanged(notice, request, 'short'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller(email).emailChangeCode(code, request, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(email).contactChanged({ ...notice, recipient: '+2348000000000' }, request,
      `contact-changed:${changeId}`)).rejects.toBeInstanceOf(BadRequestException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('admits only a masked contact, never a full address or number, and refuses unknown fields', async () => {
    for (const hint of ['n•••@example.test', '•••@example.test', '+234•••••567', '+447•••••123']) expect(MASKED_CONTACT.test(hint)).toBe(true);
    for (const hint of ['new@example.test', '+2348031234567', '<b>•••@x.test', 'n•••@exa mple.test', 'n•••@<script>',
      '&•••@attacker.example', "'•••@attacker.example", '+•••@attacker.example', 'x•••@mail_host.attacker.example',
      'x•••@bücher.example', 'x•••@a&b.example']) {
      expect(MASKED_CONTACT.test(hint)).toBe(false);
    }
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    await expect(pipe.transform({ ...notice, newContactHint: 'new@example.test' }, { type: 'body', metatype: DeliverContactChangedDto }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...notice, kind: 'nin' }, { type: 'body', metatype: DeliverContactChangedDto }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...notice, message: 'free text' }, { type: 'body', metatype: DeliverContactChangedDto }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...code, code: '12345' }, { type: 'body', metatype: DeliverEmailChangeCodeDto }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform(code, { type: 'body', metatype: DeliverEmailChangeCodeDto })).resolves.toBeDefined();
    await expect(pipe.transform(notice, { type: 'body', metatype: DeliverContactChangedDto })).resolves.toBeDefined();
    // The code email names no one: a first name or Health ID is an unknown field.
    for (const extra of [{ firstName: 'Ada' }, { healthId: 'HID-ABC234' }]) {
      await expect(pipe.transform({ ...code, ...extra }, { type: 'body', metatype: DeliverEmailChangeCodeDto }))
        .rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('admits the notice for an address of any spelling, as Identity masks it (contactChangeHint)', async () => {
    // Identity's contactChangeHint for &x@attacker.example, 'x@attacker.example, +x@attacker.example,
    // x@mail_host.attacker.example, x@bücher.example and x@a&b.example (services/identity-api,
    // patient-contact-change.service.spec.ts asserts the same strings).
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    for (const newContactHint of ['•••@attacker.example', '•••@attacker.example', '•••@attacker.example',
      'x•••@mail•host.attacker.example', 'x•••@xn--bcher-kva.example', 'x•••@a•b.example']) {
      expect(MASKED_CONTACT.test(newContactHint)).toBe(true);
      await expect(pipe.transform({ ...notice, newContactHint }, { type: 'body', metatype: DeliverContactChangedDto }))
        .resolves.toBeDefined();
      const content = contactChangedContent({ ...notice, newContactHint, supportEmail: 'support@healthidentitydirectory.com' });
      expect(content.text).toContain(`was changed to ${newContactHint}.`);
      expect(content.html).toContain(`was changed to ${newContactHint}.`);
    }
  });
});
