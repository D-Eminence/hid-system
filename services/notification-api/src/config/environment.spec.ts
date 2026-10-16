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
    META_APP_SECRET: randomBytes(24).toString('base64url'), META_WEBHOOK_VERIFY_TOKEN: randomBytes(24).toString('base64url'),
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

  it.each(['production', 'development', undefined])('rejects email-only outside explicit staging (%s)', deployment => {
    if (deployment === undefined) delete process.env.HID_DEPLOYMENT_ENV;
    else process.env.HID_DEPLOYMENT_ENV = deployment;
    expect(() => getEnvironment()).toThrow('email-only delivery profile is staging-only');
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

  it.each([['full', 'otp-email-sms delivery profile'], [undefined, 'otp-email-sms delivery profile'],
    ['email-only', 'email-only delivery profile is staging-only']])
  ('refuses the %s profile in production', (profile, error) => {
    process.env = { ...fullConfiguration(), HID_DEPLOYMENT_ENV: 'production' };
    if (profile === undefined) delete process.env.NOTIFICATION_DELIVERY_PROFILE;
    else process.env.NOTIFICATION_DELIVERY_PROFILE = profile;
    expect(() => getEnvironment()).toThrow(error);
  });

  it('requires full provider configuration for explicit full-channel staging', () => {
    process.env.NOTIFICATION_DELIVERY_PROFILE = 'full';
    expect(() => getEnvironment()).toThrow('META_ACCESS_TOKEN is required in production');
    process.env = fullConfiguration();
    expect(getEnvironment().NOTIFICATION_DELIVERY_PROFILE).toBe('full');
  });

  it('requires Brevo fallback configuration for the full staging profile', () => {
    process.env = fullConfiguration();
    process.env.NOTIFICATION_DELIVERY_PROFILE = 'full';
    delete process.env.BREVO_API_KEY;
    expect(() => getEnvironment()).toThrow('BREVO_API_KEY is required in production');
  });

  it('does not require inactive Brevo channel senders for the full profile', () => {
    process.env = fullConfiguration();
    delete process.env.BREVO_EMAIL_FROM;
    delete process.env.BREVO_SMS_SENDER;
    delete process.env.BREVO_WHATSAPP_SENDER;
    expect(getEnvironment()).toMatchObject({ BREVO_API_KEY: expect.any(String) });
  });
});

// NOTIF-PROD: production OTP goes over SES email and Termii SMS only.
describe('Notification API production otp-email-sms profile', () => {
  const original = process.env;
  const production = () => ({
    NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'production',
    NOTIFICATION_PROVIDER_MODE: 'live', NOTIFICATION_DELIVERY_PROFILE: 'otp-email-sms',
    NOTIFICATION_WORKLOAD_IDENTITY_MODE: 'jwt',
    WORKLOAD_ISSUER_URL: 'https://issuer.example.test',
    WORKLOAD_JWKS_URL: 'https://issuer.example.test/jwks.json',
    IDENTITY_CALLER_SUBJECT: 'hid:production:identity-api',
    AWS_REGION: 'eu-west-1', SES_FROM_ADDRESS: 'security@example.test',
    TERMII_BASE_URL: 'https://termii.example.test', TERMII_API_KEY: randomBytes(24).toString('base64url'),
    TERMII_SENDER_ID: 'HID',
  });

  beforeEach(() => { process.env = production(); resetEnvironmentForTests(); });
  afterEach(() => { process.env = original; resetEnvironmentForTests(); });

  it('accepts SES and Termii without Meta, WhatsApp or Brevo configuration', () => {
    expect(getEnvironment()).toMatchObject({ NOTIFICATION_DELIVERY_PROFILE: 'otp-email-sms', HID_DEPLOYMENT_ENV: 'production' });
    for (const key of ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'BREVO_API_KEY', 'BREVO_WHATSAPP_SENDER'] as const) {
      expect(getEnvironment()[key]).toBeUndefined();
    }
  });

  it('treats a Brevo fallback key as optional', () => {
    Object.assign(process.env, { BREVO_API_KEY: randomBytes(24).toString('base64url'), BREVO_SMS_SENDER: 'HID' });
    expect(getEnvironment().BREVO_API_KEY).toEqual(expect.any(String));
  });

  it.each(['SES_FROM_ADDRESS', 'TERMII_BASE_URL', 'TERMII_API_KEY', 'TERMII_SENDER_ID'])
  ('requires %s', key => {
    delete process.env[key];
    expect(() => getEnvironment()).toThrow(`${key} is required in production`);
  });

  it.each(['META_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN', 'META_OTP_TEMPLATE_NAME', 'BREVO_WHATSAPP_SENDER'])
  ('refuses WhatsApp configuration in %s', key => {
    process.env[key] = key === 'BREVO_WHATSAPP_SENDER' ? '+2348000000000' : 'synthetic-whatsapp-setting';
    expect(() => getEnvironment()).toThrow('The otp-email-sms profile does not send WhatsApp');
  });

  it('is also valid in staging, where it requires the same Termii fields', () => {
    process.env.HID_DEPLOYMENT_ENV = 'staging';
    expect(getEnvironment().NOTIFICATION_DELIVERY_PROFILE).toBe('otp-email-sms');
    delete process.env.TERMII_API_KEY;
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow('TERMII_API_KEY is required in production');
  });

  // CFG-PROD: every production refusal, one row each.
  it.each([
    ['NOTIFICATION_PROVIDER_MODE', 'disabled', 'Live providers are required'],
    ['NOTIFICATION_PROVIDER_MODE', 'test', 'test-only'],
    ['NOTIFICATION_WORKLOAD_IDENTITY_MODE', 'local-secret', 'JWT workload identity is required'],
    ['NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN', 'synthetic-local-service-token-0000000000', 'Local service tokens are forbidden in production'],
    ['AWS_ACCESS_KEY_ID', 'synthetic-invalid-static-key', 'Static AWS credentials are forbidden'],
    ['AWS_SECRET_ACCESS_KEY', 'synthetic-invalid-static-secret', 'Static AWS credentials are forbidden'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0', 'TLS verification cannot be disabled'],
    ['WORKLOAD_ISSUER_URL', 'http://issuer.example.test', 'must use HTTPS'],
    ['WORKLOAD_JWKS_URL', 'http://issuer.example.test/jwks.json', 'must use HTTPS'],
    ['TERMII_BASE_URL', 'http://termii.example.test', 'must use HTTPS'],
    ['NOTIFICATION_DELIVERY_PROFILE', 'email-only', 'staging-only'],
    ['NOTIFICATION_DELIVERY_PROFILE', 'full', 'otp-email-sms delivery profile'],
    ['EMERGENCY_CONTACT_DELIVERY_ENABLED', 'true', 'emergency-contact delivery is not approved'],
  ])('refuses %s=%s in production', (key, value, error) => {
    process.env[key] = value;
    expect(() => getEnvironment()).toThrow(error);
  });
});
