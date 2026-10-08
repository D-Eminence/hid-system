import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { MetaWhatsAppProvider } from '../providers/meta.provider';
import {
  emergencyContactAlertContent, messageContent, type OtpProvider, type ProviderResult,
} from '../providers/provider.types';
import { TermiiSmsProvider } from '../providers/termii.provider';
import { OtpPurpose } from './dto/deliver-otp.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

// The controller is constructed with an explicit authentication stub; avoid
// loading the ESM-only JWT verifier into the CommonJS test runtime.
jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

describe('Emergency-contact notification delivery', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test', HID_DEPLOYMENT_ENV: 'staging',
      TERMII_BASE_URL: 'https://termii.example.test', TERMII_API_KEY: 'secret', TERMII_SENDER_ID: 'HID',
      META_PHONE_NUMBER_ID: '123', META_ACCESS_TOKEN: 'secret', META_OTP_TEMPLATE_NAME: 'hid_otp',
    });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  const occurredAt = new Date('2026-10-08T09:15:00.000Z');

  it('renders a minimum-necessary alert without clinical or identifier content', () => {
    const content = emergencyContactAlertContent({ patientFirstName: 'Ada', facilityName: 'Lagos General', occurredAt });
    expect(content.text).toContain('Ada');
    expect(content.text).toContain('Lagos General');
    expect(content.text).toContain('8 Oct 2026');
    expect(content.text).toContain('no medical details');
    expect(content.text).not.toMatch(/diagnos|medication|result|note|HID-|NIN|record number/i);
  });

  it('uses relay wording for contact verification and keeps the generic OTP wording elsewhere', () => {
    const base = { channel: 'sms' as const, recipient: '+2348000000000', code: '482913', idempotencyKey: 'otp:verification-0001' };
    const verify = messageContent({ ...base, purpose: OtpPurpose.EMERGENCY_CONTACT_VERIFY });
    expect(verify.text).toContain('482913');
    expect(verify.text).toContain('emergency contact');
    expect(verify.text).not.toMatch(/Do not share/);
    expect(messageContent({ ...base, purpose: 'PASSWORD_RESET' }).text).toMatch(/Do not share this code/);
  });

  it('sends alert content through the SMS provider and never through the WhatsApp OTP template', async () => {
    const message = { channel: 'sms' as const, recipient: '+2348000000000', code: '', purpose: 'EMERGENCY_CONTACT_ALERT',
      idempotencyKey: 'emergency-contact:0001', content: emergencyContactAlertContent({ patientFirstName: 'Ada', facilityName: null, occurredAt }) };
    const transport = jest.fn().mockResolvedValue(new Response('{"message_id":"sms-1"}', { status: 200 }));
    await expect(new TermiiSmsProvider(getEnvironment(), transport).send(message)).resolves.toMatchObject({ outcome: 'accepted' });
    expect(JSON.parse(String(transport.mock.calls[0][1].body)).sms).toBe(message.content.text);

    const whatsapp = jest.fn();
    await expect(new MetaWhatsAppProvider(getEnvironment(), whatsapp).send({ ...message, channel: 'whatsapp' }))
      .resolves.toMatchObject({ outcome: 'definitive_failure', safeCode: 'unsupported_message' });
    await expect(new MetaWhatsAppProvider(getEnvironment(), whatsapp).send({
      ...message, channel: 'whatsapp', content: undefined, code: '482913', purpose: OtpPurpose.EMERGENCY_CONTACT_VERIFY,
    })).resolves.toMatchObject({ outcome: 'definitive_failure', safeCode: 'unsupported_message' });
    expect(whatsapp).not.toHaveBeenCalled();
  });

  function controller(sent: OtpProvider) {
    const auth = { authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService;
    const service = new NotificationService({ primary: { email: sent, sms: sent, whatsapp: sent }, fallback: sent });
    return new NotificationController(auth, service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;
  const alert = { channel: 'sms' as const, recipient: '+2348000000000', patientFirstName: 'Ada',
    facilityName: 'Lagos General', occurredAt: occurredAt.toISOString() };

  it('refuses emergency-contact delivery unless the non-production flag is enabled', async () => {
    const provider: OtpProvider = { name: 'termii', send: jest.fn() };
    await expect(controller(provider).emergencyContactAlert(alert, request, 'emergency-contact:0001'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller(provider).otp({ channel: 'sms', recipient: '+2348000000000', code: '482913',
      purpose: OtpPurpose.EMERGENCY_CONTACT_VERIFY }, request, 'otp:verification-0001')).rejects.toBeInstanceOf(ForbiddenException);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('delivers an enabled staging alert with a stable idempotency key and validated recipient', async () => {
    process.env.EMERGENCY_CONTACT_DELIVERY_ENABLED = 'true';
    resetEnvironmentForTests();
    const send = jest.fn().mockResolvedValue({ provider: 'termii', outcome: 'accepted' } satisfies ProviderResult);
    const provider: OtpProvider = { name: 'termii', send };
    await expect(controller(provider).emergencyContactAlert(alert, request, 'emergency-contact:0001'))
      .resolves.toMatchObject({ outcome: 'accepted' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'emergency-contact:0001', purpose: 'EMERGENCY_CONTACT_ALERT',
      content: expect.objectContaining({ subject: 'HID emergency access notice' }),
    }));
    await expect(controller(provider).emergencyContactAlert({ ...alert, recipient: 'not-a-phone' }, request, 'emergency-contact:0002'))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(provider).emergencyContactAlert(alert, request, 'short'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to start with emergency-contact delivery enabled in production', () => {
    Object.assign(process.env, { HID_DEPLOYMENT_ENV: 'production', EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/emergency-contact delivery is not approved/);
  });

  it('refuses a production runtime unless the deployment is explicitly staging', () => {
    Object.assign(process.env, { NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'development', EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/emergency-contact delivery is not approved/);
  });
});
