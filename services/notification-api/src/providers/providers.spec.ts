import { SESv2Client } from '@aws-sdk/client-sesv2';
import { resetEnvironmentForTests, getEnvironment } from '../config/environment';
import { BrevoFallbackProvider } from './brevo.provider';
import { MetaWhatsAppProvider } from './meta.provider';
import { SesEmailProvider } from './ses.provider';
import { emergencyContactAlertContent, genericOtpText, isTemplateOtp, messageContent } from './provider.types';
import { patientWelcomeContent } from './patient-emails';
import { TermiiSmsProvider } from './termii.provider';

describe('OTP provider adapters', () => {
  const original = { ...process.env };
  beforeEach(() => { Object.assign(process.env, { NODE_ENV:'test', NOTIFICATION_PROVIDER_MODE:'test', AWS_REGION:'af-south-1', SES_FROM_ADDRESS:'security@example.test', TERMII_BASE_URL:'https://termii.example.test', TERMII_API_KEY:'secret', TERMII_SENDER_ID:'HID', META_PHONE_NUMBER_ID:'123', META_ACCESS_TOKEN:'secret', META_OTP_TEMPLATE_NAME:'hid_otp', BREVO_API_KEY:'secret', BREVO_EMAIL_FROM:'security@example.test', BREVO_SMS_SENDER:'HID', BREVO_WHATSAPP_SENDER:'+2348000000000' }); resetEnvironmentForTests(); });
  afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); resetEnvironmentForTests(); });
  const base = { recipient:'+2348000000000', code:'012345', purpose:'PASSWORD_RESET', idempotencyKey:'otp:00000000-0000-4000-8000-000000000001' };
  it('SES returns accepted only with a provider message ID', async () => {
    const client = { send: jest.fn().mockResolvedValue({ MessageId:'ses-id' }) } as unknown as SESv2Client;
    await expect(new SesEmailProvider(getEnvironment(), client).send({ ...base, channel:'email', recipient:'person@example.test' })).resolves.toMatchObject({ outcome:'accepted', providerMessageId:'ses-id' });
  });
  it('Termii classifies explicit client rejection as definitive', async () => {
    const transport = jest.fn().mockResolvedValue(new Response('{}',{status:400}));
    await expect(new TermiiSmsProvider(getEnvironment(), transport).send({ ...base, channel:'sms' })).resolves.toMatchObject({ outcome:'definitive_failure' });
  });
  // Termii's Messaging API documents `to` in international format without a
  // plus (example 23490126727). The recipient reaches the adapter in E.164
  // ('+234...', the only form deliver-otp.dto accepts), so the adapter strips
  // the plus, as Brevo's WhatsApp path does.
  it('Termii sends the documented request body with the recipient as digits only', async () => {
    const transport = jest.fn().mockResolvedValue(new Response('{"message_id":"termii-id"}', { status: 200 }));
    await expect(new TermiiSmsProvider(getEnvironment(), transport).send({ ...base, channel:'sms' }))
      .resolves.toMatchObject({ outcome:'accepted', provider:'termii', providerMessageId:'termii-id' });
    expect(String(transport.mock.calls[0]![0])).toBe('https://termii.example.test/api/sms/send');
    expect(transport.mock.calls[0]![1]).toMatchObject({ method:'POST', headers:{ 'content-type':'application/json' } });
    expect(JSON.parse(String(transport.mock.calls[0]![1].body))).toEqual({
      api_key:'secret', to:'2348000000000', from:'HID', sms:genericOtpText('012345'),
      type:'plain', channel:'generic',
    });
    expect(String(transport.mock.calls[0]![1].body)).not.toContain('+');
  });
  it('Meta sends a six-digit authentication template parameter', async () => {
    const transport = jest.fn().mockResolvedValue(new Response('{"messages":[{"id":"wa-id"}]}',{status:200}));
    await expect(new MetaWhatsAppProvider(getEnvironment(), transport).send({ ...base, channel:'whatsapp' })).resolves.toMatchObject({ outcome:'accepted' });
    expect(String(transport.mock.calls[0][1].body)).toContain('012345'); expect(String(transport.mock.calls[0][1].body)).not.toContain('http');
  });
  it('Brevo adapter uses documented email, SMS, and WhatsApp request contracts', async () => {
    const emailTransport = jest.fn().mockResolvedValue(new Response('{"messageId":"email-id"}', { status: 201 }));
    await expect(new BrevoFallbackProvider(getEnvironment(), emailTransport).send({ ...base, channel:'email', recipient:'person@example.test' }))
      .resolves.toMatchObject({ outcome:'accepted', provider:'brevo', providerMessageId:'email-id' });
    expect(String(emailTransport.mock.calls[0]![0])).toBe('https://api.brevo.com/v3/smtp/email');
    expect(emailTransport.mock.calls[0]![1].headers).toEqual({ accept:'application/json', 'api-key':'secret', 'content-type':'application/json' });
    expect(JSON.parse(String(emailTransport.mock.calls[0]![1].body))).toEqual({
      sender: { email:'security@example.test' }, to: [{ email:'person@example.test' }],
      subject:'Your HID verification code', textContent:'Your HID verification code is 012345. It expires shortly. Do not share this code.',
    });

    const smsTransport = jest.fn().mockResolvedValue(new Response('{"messageId":123}', { status: 201 }));
    await expect(new BrevoFallbackProvider(getEnvironment(), smsTransport).send({ ...base, channel:'sms' }))
      .resolves.toMatchObject({ outcome:'accepted', provider:'brevo', providerMessageId:'123' });
    expect(String(smsTransport.mock.calls[0]![0])).toBe('https://api.brevo.com/v3/transactionalSMS/send');
    expect(JSON.parse(String(smsTransport.mock.calls[0]![1].body))).toEqual({
      sender:'HID', recipient:'+2348000000000', content:'Your HID verification code is 012345. It expires shortly. Do not share this code.', type:'transactional',
    });

    const whatsappTransport = jest.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await expect(new BrevoFallbackProvider(getEnvironment(), whatsappTransport).send({ ...base, channel:'whatsapp' }))
      .resolves.toMatchObject({ outcome:'accepted', provider:'brevo' });
    expect(String(whatsappTransport.mock.calls[0]![0])).toBe('https://api.brevo.com/v3/whatsapp/sendMessage');
    expect(JSON.parse(String(whatsappTransport.mock.calls[0]![1].body))).toEqual({
      senderNumber:'2348000000000', contactNumbers:['2348000000000'], text:'Your HID verification code is 012345. It expires shortly. Do not share this code.',
    });
  });

  it('Brevo adapter treats timeout as unknown', async () => {
    const transport = jest.fn().mockRejectedValue(new DOMException('timeout','AbortError'));
    await expect(new BrevoFallbackProvider(getEnvironment(), transport).send({ ...base, channel:'sms' })).resolves.toMatchObject({ outcome:'unknown', provider:'brevo' });
  });

  it('messageContent keeps the generic OTP wording for generic purposes', () => {
    for (const purpose of ['PASSWORD_RESET', 'SIGNUP_VERIFY', 'EMAIL_VERIFY', 'LEGACY_ACCOUNT_RECOVERY']) {
      expect(messageContent({ ...base, channel:'sms', purpose })).toEqual({ subject:'Your HID verification code', text:genericOtpText('012345') });
      expect(isTemplateOtp({ ...base, channel:'whatsapp', purpose })).toBe(true);
    }
  });

  it('messageContent gives emergency-contact codes their own wording and passes fixed content through', () => {
    expect(messageContent({ ...base, channel:'email', purpose:'EMERGENCY_CONTACT_VERIFY' })).toEqual({
      subject:'Health ID emergency contact verification',
      text:'Someone is adding you as their emergency contact on Health ID. If you agree, read this code to them: 012345. It expires shortly. If you were not expecting this, ignore this message.',
    });
    const content = { subject:'Health ID emergency access notice', text:'Fixed alert text.' };
    expect(messageContent({ ...base, channel:'email', code:'', purpose:'EMERGENCY_CONTACT_ALERT', content })).toBe(content);
    expect(isTemplateOtp({ ...base, channel:'whatsapp', purpose:'EMERGENCY_CONTACT_VERIFY' })).toBe(false);
    expect(isTemplateOtp({ ...base, channel:'whatsapp', code:'', purpose:'EMERGENCY_CONTACT_ALERT', content })).toBe(false);
  });

  it('SES and Brevo send an alert with its own subject and text', async () => {
    const content = emergencyContactAlertContent({ patientFullName:'Amina Okafor', patientHidSuffix:'EF23', clinicianName:null,
      facilityName:'Lagos General', facilityPhone:null, occurredAt:new Date('2026-10-23T13:35:00.000Z'),
      supportPhone:'+2347026717252', supportEmail:'support@healthidentitydirectory.com' });
    const alert = { ...base, channel:'email' as const, recipient:'contact@example.test', code:'', purpose:'EMERGENCY_CONTACT_ALERT', content };
    const client = { send: jest.fn().mockResolvedValue({ MessageId:'ses-id' }) } as unknown as SESv2Client;
    await expect(new SesEmailProvider(getEnvironment(), client).send(alert)).resolves.toMatchObject({ outcome:'accepted' });
    expect((client.send as jest.Mock).mock.calls[0][0].input.Content).toEqual({ Simple: {
      Subject: { Data:'Health ID emergency access notice', Charset:'UTF-8' }, Body: { Text: { Data:content.text, Charset:'UTF-8' } } } });

    const transport = jest.fn().mockResolvedValue(new Response('{"messageId":"email-id"}', { status: 201 }));
    await expect(new BrevoFallbackProvider(getEnvironment(), transport).send(alert)).resolves.toMatchObject({ outcome:'accepted' });
    expect(JSON.parse(String(transport.mock.calls[0]![1].body))).toEqual({
      sender: { email:'security@example.test' }, to: [{ email:'contact@example.test' }],
      subject:'Health ID emergency access notice', textContent:content.text,
    });
  });

  it('SES and Brevo send a patient email as text and HTML; SMS and WhatsApp stay text only', async () => {
    const content = patientWelcomeContent({ firstName:'Ada', healthId:'HID-ABC234' });
    const welcome = { ...base, channel:'email' as const, recipient:'ada@example.test', code:'', purpose:'PATIENT_WELCOME', content };
    const client = { send: jest.fn().mockResolvedValue({ MessageId:'ses-id' }) } as unknown as SESv2Client;
    await expect(new SesEmailProvider(getEnvironment(), client).send(welcome)).resolves.toMatchObject({ outcome:'accepted' });
    expect((client.send as jest.Mock).mock.calls[0][0].input.Content).toEqual({ Simple: {
      Subject: { Data:'Your Health ID is ready', Charset:'UTF-8' },
      Body: { Text: { Data:content.text, Charset:'UTF-8' }, Html: { Data:content.html, Charset:'UTF-8' } } } });

    const transport = jest.fn().mockResolvedValue(new Response('{"messageId":"email-id"}', { status: 201 }));
    await expect(new BrevoFallbackProvider(getEnvironment(), transport).send(welcome)).resolves.toMatchObject({ outcome:'accepted' });
    expect(JSON.parse(String(transport.mock.calls[0]![1].body))).toEqual({
      sender: { email:'security@example.test' }, to: [{ email:'ada@example.test' }],
      subject:'Your Health ID is ready', textContent:content.text, htmlContent:content.html,
    });

    const smsTransport = jest.fn().mockResolvedValue(new Response('{"messageId":1}', { status: 201 }));
    await new BrevoFallbackProvider(getEnvironment(), smsTransport).send({ ...welcome, channel:'sms', recipient:'+2348000000000' });
    expect(JSON.parse(String(smsTransport.mock.calls[0]![1].body))).toEqual({
      sender:'HID', recipient:'+2348000000000', content:content.text, type:'transactional' });
    const whatsappTransport = jest.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await new BrevoFallbackProvider(getEnvironment(), whatsappTransport).send({ ...welcome, channel:'whatsapp', recipient:'+2348000000000' });
    expect(String(whatsappTransport.mock.calls[0]![1].body)).not.toContain('<');
  });

  it('Brevo SMS sends the emergency-contact verification wording', async () => {
    const transport = jest.fn().mockResolvedValue(new Response('{"messageId":1}', { status: 201 }));
    await new BrevoFallbackProvider(getEnvironment(), transport).send({ ...base, channel:'sms', purpose:'EMERGENCY_CONTACT_VERIFY' });
    expect(JSON.parse(String(transport.mock.calls[0]![1].body)).content).toBe(messageContent({ ...base, channel:'sms', purpose:'EMERGENCY_CONTACT_VERIFY' }).text);
  });

  it('Brevo fails closed when the selected fallback channel has no configured sender', async () => {
    delete process.env.BREVO_SMS_SENDER;
    resetEnvironmentForTests();
    const transport = jest.fn();
    await expect(new BrevoFallbackProvider(getEnvironment(), transport).send({ ...base, channel:'sms' }))
      .resolves.toEqual({ outcome:'definitive_failure', provider:'brevo', safeCode:'channel_not_configured' });
    expect(transport).not.toHaveBeenCalled();
  });
});
