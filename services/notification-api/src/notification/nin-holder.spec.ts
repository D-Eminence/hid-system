import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { BrevoFallbackProvider } from '../providers/brevo.provider';
import { MetaWhatsAppProvider } from '../providers/meta.provider';
import {
  isTemplateOtp, messageContent, ninHolderVerificationText, type OtpProvider, type ProviderResult,
} from '../providers/provider.types';
import { TermiiSmsProvider } from '../providers/termii.provider';
import { DeliverOtpDto, OtpPurpose } from './dto/deliver-otp.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

// The controller is constructed with an explicit authentication stub; avoid
// loading the ESM-only JWT verifier into the CommonJS test runtime.
jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

// ADR-062: the code that proves a person holds a NIN goes to the phone the NIN
// record lists, by SMS only. Whoever holds that phone may not be the person
// registering, so the text says why it came and names nothing else.
describe('NIN holder code delivery', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test',
      TERMII_BASE_URL: 'https://termii.example.test', TERMII_API_KEY: 'secret', TERMII_SENDER_ID: 'HID',
      META_PHONE_NUMBER_ID: '123', META_ACCESS_TOKEN: 'secret', META_OTP_TEMPLATE_NAME: 'hid_otp',
      BREVO_API_KEY: 'secret', BREVO_EMAIL_FROM: 'security@example.test', BREVO_SMS_SENDER: 'HID',
      BREVO_WHATSAPP_SENDER: '+2348000000000',
    });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  const holderText = 'Your Health ID code is 482913. Someone is registering for a Health ID with your NIN. '
    + 'If this was not you, ignore this message. Do not share this code. '
    + 'Health ID will never call or message you to ask for it.';
  const message = { channel: 'sms' as const, recipient: '+2348000000000', code: '482913',
    purpose: OtpPurpose.NIN_HOLDER_VERIFY, idempotencyKey: 'otp:00000000-0000-4000-8000-000000000093' };

  it('accepts the purpose at the request boundary', async () => {
    const input = plainToInstance(DeliverOtpDto, { channel: 'sms', recipient: '+2348000000000', code: '482913',
      purpose: 'NIN_HOLDER_VERIFY' });
    expect(await validate(input, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });

  it('says why the code came and names no NIN, person, Health ID or link', () => {
    expect(ninHolderVerificationText('482913')).toBe(holderText);
    expect(messageContent(message)).toEqual({ subject: 'Your Health ID code', text: holderText });
    expect(holderText).not.toMatch(/https?:|www\.|HID-|\d{11}/);
    // Other purposes keep their own wording.
    expect(messageContent({ ...message, purpose: 'PASSWORD_RESET' }).text).not.toContain('NIN');
  });

  it('sends the holder wording by SMS, through the primary and the fallback provider', async () => {
    const termii = jest.fn().mockResolvedValue(new Response('{"message_id":"sms-1"}', { status: 200 }));
    await expect(new TermiiSmsProvider(getEnvironment(), termii).send(message)).resolves.toMatchObject({ outcome: 'accepted' });
    expect(JSON.parse(String(termii.mock.calls[0][1].body)).sms).toBe(holderText);
    const brevo = jest.fn().mockResolvedValue(new Response('{"messageId":123}', { status: 201 }));
    await expect(new BrevoFallbackProvider(getEnvironment(), brevo).send(message)).resolves.toMatchObject({ outcome: 'accepted' });
    expect(JSON.parse(String(brevo.mock.calls[0]![1].body)).content).toBe(holderText);
  });

  it('never sends it through the WhatsApp OTP template, which would drop the warning', async () => {
    expect(isTemplateOtp(message)).toBe(false);
    expect(isTemplateOtp({ ...message, purpose: 'PASSWORD_RESET' })).toBe(true);
    const whatsapp = jest.fn();
    await expect(new MetaWhatsAppProvider(getEnvironment(), whatsapp).send({ ...message, channel: 'whatsapp' }))
      .resolves.toMatchObject({ outcome: 'definitive_failure', safeCode: 'unsupported_message' });
    expect(whatsapp).not.toHaveBeenCalled();
  });

  function controller(sent: OtpProvider) {
    const auth = { authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService;
    const service = new NotificationService({ primary: { email: sent, sms: sent, whatsapp: sent }, fallback: sent });
    return { controller: new NotificationController(auth, service), service };
  }
  const request = { header: () => 'identity-api' } as unknown as Request;

  it.each([
    ['email', 'person@example.test'],
    ['whatsapp', '+2348000000000'],
  ] as const)('refuses a holder code by %s before any provider', async (channel, recipient) => {
    const provider: OtpProvider = { name: 'termii', send: jest.fn() };
    const { controller: api, service } = controller(provider);
    await expect(api.otp({ channel, recipient, code: '482913', purpose: OtpPurpose.NIN_HOLDER_VERIFY },
      request, 'otp:holder-refusal-0001')).rejects.toBeInstanceOf(BadRequestException);
    // The service refuses it too, whoever calls it.
    await expect(service.deliverOtp({ ...message, channel, recipient })).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('delivers a holder code by SMS with the holder wording', async () => {
    const send = jest.fn().mockResolvedValue({ provider: 'termii', outcome: 'accepted' } satisfies ProviderResult);
    const { controller: api } = controller({ name: 'termii', send });
    await expect(api.otp({ channel: 'sms', recipient: '+2348000000000', code: '482913',
      purpose: OtpPurpose.NIN_HOLDER_VERIFY }, request, 'otp:holder-delivery-0001'))
      .resolves.toMatchObject({ outcome: 'accepted' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', purpose: 'NIN_HOLDER_VERIFY',
      code: '482913', idempotencyKey: 'otp:holder-delivery-0001' }));
    expect(messageContent(send.mock.calls[0][0]).text).toBe(holderText);
  });
});
