import { randomBytes } from 'node:crypto';
import { getEnvironment, resetEnvironmentForTests } from './environment';

describe('Notification API delivery profile validation', () => {
  const original = process.env;
  const emailConfiguration = {
    NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'staging',
    NOTIFICATION_PROVIDER_MODE: 'live', NOTIFICATION_DELIVERY_PROFILE: 'email-only',
    NOTIFICATION_WORKLOAD_IDENTITY_MODE: 'jwt',
    WORKLOAD_ISSUER_URL: 'https://issuer.example.test',
    WORKLOAD_JWKS_URL: 'https://issuer.example.test/jwks.json',
    IDENTITY_CALLER_SUBJECT: 'hid:staging:identity-api',
    AWS_REGION: 'af-south-1', SES_FROM_ADDRESS: 'security@example.test',
  };
  const fullConfiguration = () => ({
    ...emailConfiguration, NOTIFICATION_DELIVERY_PROFILE: 'full',
    TERMII_BASE_URL: 'https://termii.example.test', TERMII_API_KEY: randomBytes(24).toString('base64url'), TERMII_SENDER_ID: 'HID',
    META_PHONE_NUMBER_ID: '123', META_ACCESS_TOKEN: randomBytes(24).toString('base64url'), META_OTP_TEMPLATE_NAME: 'hid_otp',
    BREVO_API_KEY: randomBytes(24).toString('base64url'), BREVO_EMAIL_FROM: 'security@example.test',
    BREVO_SMS_SENDER: 'HID', BREVO_WHATSAPP_SENDER: '2348000000000',
  });

  beforeEach(() => { process.env = { ...emailConfiguration }; resetEnvironmentForTests(); });
  afterEach(() => { process.env = original; resetEnvironmentForTests(); });

  it('accepts live staging email without unrelated provider credentials', () => {
    expect(getEnvironment()).toMatchObject({ NOTIFICATION_DELIVERY_PROFILE: 'email-only', NOTIFICATION_PROVIDER_MODE: 'live' });
    for (const key of ['TERMII_API_KEY', 'META_ACCESS_TOKEN', 'BREVO_API_KEY'] as const) {
      expect(getEnvironment()[key]).toBeUndefined();
    }
  });

  it('accepts staging email fallback with only SES and Brevo credentials', () => {
    Object.assign(process.env, { NOTIFICATION_DELIVERY_PROFILE: 'email-brevo',
      BREVO_API_KEY: 'invented-test-credential', BREVO_EMAIL_FROM: 'security@example.test' });
    expect(getEnvironment().NOTIFICATION_DELIVERY_PROFILE).toBe('email-brevo');
    expect(getEnvironment().TERMII_API_KEY).toBeUndefined();
    expect(getEnvironment().META_ACCESS_TOKEN).toBeUndefined();
  });

  it.each(['BREVO_API_KEY', 'BREVO_EMAIL_FROM'])('requires %s for staging fallback', key => {
    Object.assign(process.env, { NOTIFICATION_DELIVERY_PROFILE: 'email-brevo',
      BREVO_API_KEY: 'invented-test-credential', BREVO_EMAIL_FROM: 'security@example.test' });
    delete process.env[key];
    expect(() => getEnvironment()).toThrow(`${key} is required for email fallback`);
  });

  it.each(['production', 'development', undefined])('permits email-only with production security checks (%s)', deployment => {
    if (deployment === undefined) delete process.env.HID_DEPLOYMENT_ENV;
    else process.env.HID_DEPLOYMENT_ENV = deployment;
    expect(getEnvironment().NOTIFICATION_DELIVERY_PROFILE).toBe('email-only');
  });

  it('permits production email fallback without SMS or Meta credentials', () => {
    Object.assign(process.env, { HID_DEPLOYMENT_ENV: 'production', NOTIFICATION_DELIVERY_PROFILE: 'email-brevo',
      BREVO_API_KEY: 'invented-test-credential', BREVO_EMAIL_FROM: 'security@example.test' });
    expect(getEnvironment().NOTIFICATION_DELIVERY_PROFILE).toBe('email-brevo');
    expect(getEnvironment().META_ACCESS_TOKEN).toBeUndefined();
  });

  const smsConfiguration = () => ({ ...emailConfiguration, HID_DEPLOYMENT_ENV: 'production',
    NOTIFICATION_DELIVERY_PROFILE: 'email-sms-brevo', TERMII_BASE_URL: 'https://termii.example.test',
    TERMII_API_KEY: 'invented-test-credential', TERMII_SENDER_ID: 'HID',
    BREVO_API_KEY: 'invented-test-credential', BREVO_EMAIL_FROM: 'security@example.test', BREVO_SMS_SENDER: 'HID' });

  it('permits email and SMS fallback without requiring WhatsApp credentials', () => {
    process.env = smsConfiguration();
    expect(getEnvironment().NOTIFICATION_DELIVERY_PROFILE).toBe('email-sms-brevo');
    expect(getEnvironment().META_ACCESS_TOKEN).toBeUndefined();
  });

  it.each(['TERMII_BASE_URL', 'TERMII_API_KEY', 'TERMII_SENDER_ID', 'BREVO_SMS_SENDER'])
  ('requires %s when SMS is enabled', key => {
    process.env = smsConfiguration(); delete process.env[key];
    expect(() => getEnvironment()).toThrow(`${key} is required for SMS delivery`);
  });

  it.each(['WORKLOAD_ISSUER_URL', 'WORKLOAD_JWKS_URL', 'IDENTITY_CALLER_SUBJECT', 'AWS_REGION', 'SES_FROM_ADDRESS'])
  ('keeps %s mandatory for live staging email', key => {
    delete process.env[key];
    expect(() => getEnvironment()).toThrow(`${key} is required in production`);
  });

  it.each([
    ['NOTIFICATION_PROVIDER_MODE', 'disabled', 'Live providers are required'],
    ['NOTIFICATION_PROVIDER_MODE', 'test', 'test-only'],
    ['NOTIFICATION_WORKLOAD_IDENTITY_MODE', 'local-secret', 'JWT workload identity is required'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0', 'TLS verification cannot be disabled'],
    ['WORKLOAD_ISSUER_URL', 'http://issuer.example.test', 'must use HTTPS'],
    ['WORKLOAD_JWKS_URL', 'http://issuer.example.test/jwks.json', 'must use HTTPS'],
    ['AWS_ACCESS_KEY_ID', 'synthetic-invalid-static-key', 'Static AWS credentials are forbidden'],
  ])('retains production security validation for %s', (key, value, error) => {
    process.env[key!] = value;
    expect(() => getEnvironment()).toThrow(error);
  });

  it('preserves full-channel default production validation', () => {
    process.env = { ...emailConfiguration, HID_DEPLOYMENT_ENV: 'production' };
    delete process.env.NOTIFICATION_DELIVERY_PROFILE;
    expect(() => getEnvironment()).toThrow('TERMII_API_KEY is required in production');
    process.env = { ...fullConfiguration(), HID_DEPLOYMENT_ENV: 'production' };
    delete process.env.NOTIFICATION_DELIVERY_PROFILE;
    expect(getEnvironment().NOTIFICATION_DELIVERY_PROFILE).toBe('full');
  });

  it('requires full provider configuration for explicit full-channel staging', () => {
    process.env.NOTIFICATION_DELIVERY_PROFILE = 'full';
    expect(() => getEnvironment()).toThrow('META_ACCESS_TOKEN is required in production');
    process.env = fullConfiguration();
    expect(getEnvironment().NOTIFICATION_DELIVERY_PROFILE).toBe('full');
  });

  it('requires Brevo fallback configuration for the full production profile', () => {
    process.env = { ...fullConfiguration(), HID_DEPLOYMENT_ENV: 'production' };
    delete process.env.BREVO_API_KEY;
    expect(() => getEnvironment()).toThrow('BREVO_API_KEY is required in production');
  });

  it('does not require inactive Brevo channel senders for the full profile', () => {
    process.env = { ...fullConfiguration(), HID_DEPLOYMENT_ENV: 'production' };
    delete process.env.BREVO_EMAIL_FROM;
    delete process.env.BREVO_SMS_SENDER;
    delete process.env.BREVO_WHATSAPP_SENDER;
    expect(getEnvironment()).toMatchObject({ BREVO_API_KEY: expect.any(String) });
  });
});
