import { SESv2Client } from '@aws-sdk/client-sesv2';
import { resetEnvironmentForTests, getEnvironment } from '../config/environment';
import { InfobipFallbackProvider } from './infobip.provider';
import { MetaWhatsAppProvider } from './meta.provider';
import { SesEmailProvider } from './ses.provider';
import { TermiiSmsProvider } from './termii.provider';

describe('OTP provider adapters', () => {
  const original = { ...process.env };
  beforeEach(() => { Object.assign(process.env, { NODE_ENV:'test', NOTIFICATION_PROVIDER_MODE:'test', AWS_REGION:'af-south-1', SES_FROM_ADDRESS:'security@example.test', TERMII_BASE_URL:'https://termii.example.test', TERMII_API_KEY:'secret', TERMII_SENDER_ID:'HID', META_PHONE_NUMBER_ID:'123', META_ACCESS_TOKEN:'secret', META_OTP_TEMPLATE_NAME:'hid_otp', INFOBIP_BASE_URL:'https://infobip.example.test', INFOBIP_API_KEY:'secret', INFOBIP_SMS_SENDER:'HID' }); resetEnvironmentForTests(); });
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
  it('Infobip adapter supports SMS fallback and treats timeout as unknown', async () => {
    const transport = jest.fn().mockRejectedValue(new DOMException('timeout','AbortError'));
    await expect(new InfobipFallbackProvider(getEnvironment(), transport).send({ ...base, channel:'sms' })).resolves.toMatchObject({ outcome:'unknown' });
  });
});
