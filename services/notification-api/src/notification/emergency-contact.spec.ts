import { BadRequestException, ForbiddenException, HttpException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { MetaWhatsAppProvider } from '../providers/meta.provider';
import {
  alertTime, displayPhone, emergencyContactAlertContent, messageContent, type OtpProvider, type ProviderResult,
} from '../providers/provider.types';
import { TermiiSmsProvider } from '../providers/termii.provider';
import { DeliverEmergencyContactAlertDto } from './dto/deliver-emergency-contact-alert.dto';
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

  // 14:35 in Lagos (WAT, UTC+1).
  const occurredAt = new Date('2026-10-23T13:35:00.000Z');
  const support = { supportPhone: '+2347026717252', supportEmail: 'support@healthidentitydirectory.com' };
  const patient = { patientFullName: 'Amina Okafor', patientHidSuffix: 'EF23', occurredAt, ...support };

  describe('alert text', () => {
    it.each([
      ['Dr Bola Adeyemi', 'Lagos General', '+2348030000000',
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by Dr Bola Adeyemi at Lagos General on 23 Oct 2026, 14:35 (WAT). For more information, call Lagos General on +234 803 000 0000. To stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.'],
      ['Dr Bola Adeyemi', 'Lagos General', null,
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by Dr Bola Adeyemi at Lagos General on 23 Oct 2026, 14:35 (WAT). For more information, or to stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.'],
      ['Dr Bola Adeyemi', null, '+2348030000000',
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by Dr Bola Adeyemi on 23 Oct 2026, 14:35 (WAT). For more information, call the facility on +234 803 000 0000. To stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.'],
      ['Dr Bola Adeyemi', null, null,
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by Dr Bola Adeyemi on 23 Oct 2026, 14:35 (WAT). For more information, or to stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.'],
      [null, 'Lagos General', '+2348030000000',
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by a health worker at Lagos General on 23 Oct 2026, 14:35 (WAT). For more information, call Lagos General on +234 803 000 0000. To stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.'],
      [null, 'Lagos General', null,
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by a health worker at Lagos General on 23 Oct 2026, 14:35 (WAT). For more information, or to stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.'],
      [null, null, '+2348030000000',
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by a health worker on 23 Oct 2026, 14:35 (WAT). For more information, call the facility on +234 803 000 0000. To stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.'],
      [null, null, null,
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by a health worker on 23 Oct 2026, 14:35 (WAT). For more information, or to stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.'],
    ])('clinician %p, facility %p, facility phone %p', (clinicianName, facilityName, facilityPhone, text) => {
      expect(emergencyContactAlertContent({ ...patient, clinicianName, facilityName, facilityPhone }))
        .toEqual({ subject: 'Health ID emergency access notice', text });
    });

    it('has no free-text slot, no full Health ID and no "no medical details" claim', () => {
      const content = emergencyContactAlertContent({ ...patient, clinicianName: 'Dr Bola Adeyemi', facilityName: 'Lagos General',
        facilityPhone: '+2348030000000', reason: 'Unconscious after a road traffic crash', patientHid: 'HID-ABCDEF23' } as never);
      expect(content.text).not.toMatch(/Unconscious|road traffic|HID-|ABCDEF23|no medical details|diagnos|medication|NIN/i);
      expect(content.text).toContain('for emergency care');
    });

    it('formats the time in Lagos as d MMM yyyy, HH:mm', () => {
      expect(alertTime(new Date('2026-10-08T09:15:00.000Z'))).toBe('8 Oct 2026, 10:15');
      expect(alertTime(new Date('2026-09-03T23:05:00.000Z'))).toBe('4 Sep 2026, 00:05');
      expect(alertTime(new Date('2026-12-31T23:30:00.000Z'))).toBe('1 Jan 2027, 00:30');
      expect(alertTime(new Date('2026-05-01T11:00:00.000Z'))).toBe('1 May 2026, 12:00');
    });

    it('shows a +234 number as +234 XXX XXX XXXX and any other E.164 number as is', () => {
      expect(displayPhone('+2347026717252')).toBe('+234 702 671 7252');
      expect(displayPhone('+2348030000000')).toBe('+234 803 000 0000');
      expect(displayPhone('+447700900123')).toBe('+447700900123');
      expect(displayPhone('+23412345678')).toBe('+23412345678');
    });
  });

  it('uses relay wording for contact verification and keeps the generic OTP wording elsewhere', () => {
    const base = { channel: 'sms' as const, recipient: '+2348000000000', code: '482913', idempotencyKey: 'otp:verification-0001' };
    expect(messageContent({ ...base, purpose: OtpPurpose.EMERGENCY_CONTACT_VERIFY })).toEqual({
      subject: 'Health ID emergency contact verification',
      text: 'Someone is adding you as their emergency contact on Health ID. If you agree, read this code to them: 482913. It expires shortly. If you were not expecting this, ignore this message.',
    });
    expect(messageContent({ ...base, purpose: 'PASSWORD_RESET' })).toEqual({
      subject: 'Your HID verification code',
      text: 'Your HID verification code is 482913. It expires shortly. Do not share this code.',
    });
  });

  it('sends alert content through the SMS provider and never through the WhatsApp OTP template', async () => {
    const message = { channel: 'sms' as const, recipient: '+2348000000000', code: '', purpose: 'EMERGENCY_CONTACT_ALERT',
      idempotencyKey: 'emergency-contact:0001',
      content: emergencyContactAlertContent({ ...patient, clinicianName: null, facilityName: null, facilityPhone: null }) };
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
  function provider(name: ProviderResult['provider']): OtpProvider {
    return { name, send: jest.fn().mockResolvedValue({ provider: name, outcome: 'accepted' } satisfies ProviderResult) };
  }
  const request = { header: () => 'identity-api' } as unknown as Request;
  const alert = { channel: 'sms' as const, recipient: '+2348000000000', patientFullName: 'Amina Okafor',
    patientHidSuffix: 'EF23', clinicianName: 'Dr Bola Adeyemi', facilityName: 'Lagos General', facilityPhone: null,
    occurredAt: occurredAt.toISOString() };
  const verification = { channel: 'sms' as const, recipient: '+2348000000000', code: '482913', purpose: OtpPurpose.EMERGENCY_CONTACT_VERIFY };
  const enable = (values: Record<string, string> = {}) => {
    Object.assign(process.env, { EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', ...values });
    resetEnvironmentForTests();
  };

  describe('while delivery is disabled', () => {
    beforeEach(() => {
      process.env.EMERGENCY_CONTACT_DELIVERY_ENABLED = 'false';
      resetEnvironmentForTests();
    });

    it('answers the alert route 503 EMERGENCY_CONTACT_DELIVERY_DISABLED, so identity-api retries it', async () => {
      const sent = provider('termii');
      const error = await controller(sent).emergencyContactAlert(alert, request, 'emergency-contact:0001').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as HttpException).getStatus()).toBe(503);
      expect((error as HttpException).getResponse()).toEqual({ statusCode: 503, error: 'Service Unavailable',
        code: 'EMERGENCY_CONTACT_DELIVERY_DISABLED', message: 'Emergency-contact delivery is disabled' });
      expect(sent.send).not.toHaveBeenCalled();
    });

    it('answers the verification purpose 403 and leaves other purposes alone', async () => {
      const sent = provider('termii');
      await expect(controller(sent).otp(verification, request, 'otp:verification-0001')).rejects.toBeInstanceOf(ForbiddenException);
      expect(sent.send).not.toHaveBeenCalled();
      await expect(controller(sent).otp({ ...verification, purpose: OtpPurpose.PASSWORD_RESET }, request, 'otp:verification-0001'))
        .resolves.toMatchObject({ outcome: 'accepted' });
      expect(sent.send).toHaveBeenCalledTimes(1);
    });

  });

  it('is enabled by default (owner approval, 2026-10-24): production sets no key', () => {
    delete process.env.EMERGENCY_CONTACT_DELIVERY_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED).toBe(true);
  });

  describe('while delivery is enabled', () => {
    it('delivers an alert with a stable idempotency key, the rendered content and Novu\'s response shape', async () => {
      enable();
      const sent = provider('termii');
      await expect(controller(sent).emergencyContactAlert(alert, request, 'emergency-contact:0001')).resolves.toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), outcome: 'accepted', primary: { provider: 'termii', outcome: 'accepted' },
      });
      expect(sent.send).toHaveBeenCalledWith({
        channel: 'sms', recipient: '+2348000000000', code: '', purpose: 'EMERGENCY_CONTACT_ALERT',
        idempotencyKey: 'emergency-contact:0001',
        content: {
          subject: 'Health ID emergency access notice',
          text: 'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by Dr Bola Adeyemi at Lagos General on 23 Oct 2026, 14:35 (WAT). For more information, or to stop these alerts, contact Health ID support on +234 702 671 7252 or support@healthidentitydirectory.com.',
        },
      });
    });

    it('renders the configured support phone and email', async () => {
      enable({ EMERGENCY_CONTACT_SUPPORT_PHONE: '+447700900123', EMERGENCY_CONTACT_SUPPORT_EMAIL: 'help@example.test' });
      const sent = provider('termii');
      await controller(sent).emergencyContactAlert({ ...alert, clinicianName: undefined, facilityName: undefined,
        facilityPhone: '+2348030000000' }, request, 'emergency-contact:0001');
      expect((sent.send as jest.Mock).mock.calls[0][0].content.text).toBe(
        'Health ID safety notice: Amina Okafor (Health ID ending EF23), who listed you as an emergency contact, had their health record opened for emergency care by a health worker on 23 Oct 2026, 14:35 (WAT). For more information, call the facility on +234 803 000 0000. To stop these alerts, contact Health ID support on +447700900123 or help@example.test.');
    });

    it('refuses an invalid recipient, idempotency key or channel before any provider call', async () => {
      enable();
      const sent = provider('termii');
      await expect(controller(sent).emergencyContactAlert({ ...alert, recipient: 'not-a-phone' }, request, 'emergency-contact:0002'))
        .rejects.toBeInstanceOf(BadRequestException);
      await expect(controller(sent).emergencyContactAlert(alert, request, 'short')).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller(sent).emergencyContactAlert({ ...alert, channel: 'whatsapp' as never }, request, 'emergency-contact:0003'))
        .rejects.toThrow('delivered by email or SMS only');
      await expect(controller(sent).otp({ ...verification, channel: 'whatsapp' }, request, 'otp:verification-0001'))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(sent.send).not.toHaveBeenCalled();
    });

    it('delivers a verification code with the relay wording', async () => {
      enable();
      const transport = jest.fn().mockResolvedValue(new Response('{"message_id":"sms-1"}', { status: 200 }));
      const sms = new TermiiSmsProvider(getEnvironment(), transport);
      await expect(controller(sms).otp(verification, request, 'otp:verification-0001')).resolves.toMatchObject({ outcome: 'accepted' });
      expect(JSON.parse(String(transport.mock.calls[0][1].body)).sms).toBe(
        'Someone is adding you as their emergency contact on Health ID. If you agree, read this code to them: 482913. It expires shortly. If you were not expecting this, ignore this message.');
    });

    it('is accepted in production', () => {
      delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY;
      Object.assign(process.env, { NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'production', NOTIFICATION_PROVIDER_MODE: 'live',
        NOTIFICATION_DELIVERY_PROFILE: 'email-brevo', NOTIFICATION_WORKLOAD_IDENTITY_MODE: 'jwt',
        WORKLOAD_ISSUER_URL: 'https://issuer.example.test', WORKLOAD_JWKS_URL: 'https://issuer.example.test/jwks.json',
        IDENTITY_CALLER_SUBJECT: 'hid:production:identity-api', AWS_REGION: 'eu-west-1', SES_FROM_ADDRESS: 'security@example.test',
        BREVO_API_KEY: 'invented-test-credential', BREVO_EMAIL_FROM: 'security@example.test',
        EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true' });
      resetEnvironmentForTests();
      expect(getEnvironment()).toMatchObject({ EMERGENCY_CONTACT_DELIVERY_ENABLED: true, HID_DEPLOYMENT_ENV: 'production' });
    });
  });

  // Production notification-api runs email-brevo, which sends email only.
  describe('under the email-brevo profile', () => {
    beforeEach(() => enable({ NOTIFICATION_DELIVERY_PROFILE: 'email-brevo' }));

    it('refuses an SMS verification code and an SMS alert with 400 before any provider call', async () => {
      const sent = provider('termii');
      await expect(controller(sent).otp(verification, request, 'otp:verification-0001')).rejects.toThrow('supports email OTP only');
      const error = await controller(sent).emergencyContactAlert(alert, request, 'emergency-contact:0001').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as HttpException).message).toBe('This delivery profile supports email OTP only');
      expect(sent.send).not.toHaveBeenCalled();
    });

    it('delivers an email verification code and an email alert', async () => {
      const sent = provider('ses');
      await expect(controller(sent).otp({ ...verification, channel: 'email', recipient: 'contact@example.test' }, request,
        'otp:verification-0001')).resolves.toMatchObject({ outcome: 'accepted', primary: { provider: 'ses' } });
      await expect(controller(sent).emergencyContactAlert({ ...alert, channel: 'email', recipient: 'contact@example.test' }, request,
        'emergency-contact:0001')).resolves.toMatchObject({ outcome: 'accepted', primary: { provider: 'ses' } });
      expect(sent.send).toHaveBeenCalledTimes(2);
      expect((sent.send as jest.Mock).mock.calls[1][0]).toMatchObject({ channel: 'email', purpose: 'EMERGENCY_CONTACT_ALERT',
        content: { subject: 'Health ID emergency access notice' } });
    });
  });

  // The same options as the application's global pipe (main.ts).
  describe('alert DTO', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const validate = (body: Record<string, unknown>) => pipe.transform(body, { type: 'body', metatype: DeliverEmergencyContactAlertDto });
    const body = { ...alert, facilityPhone: '+2348030000000', plan: { capability: 'sms' } };

    it('accepts the fixed field set, with the optional fields given, null or absent', async () => {
      await expect(validate(body)).resolves.toBeInstanceOf(DeliverEmergencyContactAlertDto);
      await expect(validate({ ...body, clinicianName: null, facilityName: null, facilityPhone: null })).resolves.toBeDefined();
      const { clinicianName: _c, facilityName: _f, facilityPhone: _p, plan: _plan, ...required } = body;
      await expect(validate(required)).resolves.toBeDefined();
      await expect(validate({ ...body, patientFullName: 'Ọlá Àdìsá-Okafor', patientHidSuffix: 'Z2H9' })).resolves.toBeDefined();
    });

    it.each(['patientHid', 'hidCode', 'reason', 'breakGlassReason', 'message', 'patientFirstName'])
    ('rejects an unknown %s field, so no full Health ID or free text can be sent', async (field) => {
      await expect(validate({ ...body, [field]: field === 'patientHid' ? 'HID-ABCDEF23' : 'free text' }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it.each(['HID-ABCDEF23', 'ABCDEF23', 'ef23', 'EF2', 'EF234', 'EF0I', 'EO23', 'E123', ' EF2', ''])
    ('rejects the Health ID suffix %p', async (patientHidSuffix) => {
      await expect(validate({ ...body, patientHidSuffix })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires the Health ID suffix', async () => {
      const { patientHidSuffix: _suffix, ...rest } = body;
      await expect(validate(rest)).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['facilityPhone', '08030000000'], ['facilityPhone', '+234 803 000 0000'], ['facilityPhone', '+0803000000'],
      ['patientFullName', ''], ['patientFullName', '1 Amina'], ['patientFullName', 'Amina <b>'], ['patientFullName', 'A'.repeat(121)],
      ['clinicianName', 'Dr Bola: see notes'], ['facilityName', 'Lagos General; call 112'], ['channel', 'whatsapp'],
      ['recipient', 'a'.repeat(321)], ['occurredAt', '23 Oct 2026'], ['occurredAt', '2026-02-30T10:00:00Z'],
    ])('rejects %s %p', async (field, value) => {
      await expect(validate({ ...body, [field]: value })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
