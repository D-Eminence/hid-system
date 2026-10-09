import { SESv2Client } from '@aws-sdk/client-sesv2';
import { resetEnvironmentForTests, getEnvironment } from '../config/environment';
import { BrevoFallbackProvider } from './brevo.provider';
import { MetaWhatsAppProvider } from './meta.provider';
import { SesEmailProvider } from './ses.provider';
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

  it('Brevo fails closed when the selected fallback channel has no configured sender', async () => {
    delete process.env.BREVO_SMS_SENDER;
    resetEnvironmentForTests();
    const transport = jest.fn();
    await expect(new BrevoFallbackProvider(getEnvironment(), transport).send({ ...base, channel:'sms' }))
      .resolves.toEqual({ outcome:'definitive_failure', provider:'brevo', safeCode:'channel_not_configured' });
    expect(transport).not.toHaveBeenCalled();
  });
});
