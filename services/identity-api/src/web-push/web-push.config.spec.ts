import { syntheticVapidPublicKey } from '../../test/web-push.fixtures';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import { validVapidSubject, vapidPublicKeyBytes, webPushConfiguration } from './web-push.config';
import { webPushKeyId } from './web-push-endpoint';

describe('Identity web push configuration (B6, D13)', () => {
  const original = { ...process.env };
  const publicKey = syntheticVapidPublicKey();
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function test(overrides: Record<string, string | undefined>): void {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://app.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456' });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetEnvironmentForTests();
  }

  function production(overrides: Record<string, string | undefined>): void {
    Object.assign(process.env, {
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://identity:test@db.example/hid',
      DATABASE_SSL: 'true', DATABASE_SSL_ROOT_CERT_BASE64: 'trusted-ca',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', TRUST_PROXY_CIDRS: '10.0.0.0/8',
      AUTH_MODE: 'oidc', AUTH_COOKIE_SECURE: 'true', OIDC_ISSUER_URL: 'https://issuer.example',
      OIDC_AUDIENCE: 'hid-api', OIDC_JWKS_URL: 'https://issuer.example/jwks', IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
      WORKLOAD_ISSUER_URL: 'https://workloads.example', WORKLOAD_AUDIENCE: 'hid-identity-api', HID_DEPLOYMENT_ENV: 'production',
      WORKLOAD_JWKS_URL: 'https://workloads.example/jwks', IDENTITY_EHR_CALLER_SUBJECT: 'workload:ehr',
      IDENTITY_LAB_CALLER_SUBJECT: 'workload:lab', IDENTITY_PHARMACY_CALLER_SUBJECT: 'workload:pharmacy',
      IDENTITY_OCR_CALLER_SUBJECT: 'workload:ocr', OUTREACH_CALLER_SUBJECT: 'workload:outreach',
      TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'server-only-turnstile-secret',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'), CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 8).toString('base64'),
      NOTIFICATION_API_URL: 'https://notification.internal.example', NOTIFICATION_SERVICE_IDENTITY_MODE: 'jwt',
      NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: '/var/run/secrets/notification.jwt',
    });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetEnvironmentForTests();
  }

  it('is off (missing) without the keys, and production starts without them', () => {
    production({ WEB_PUSH_VAPID_PUBLIC_KEY: undefined, WEB_PUSH_SUBJECT: undefined });
    expect(() => getEnvironment()).not.toThrow();
    expect(webPushConfiguration()).toEqual({ on: false, reason: 'missing' });
    production({ WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_SUBJECT: '' });
    expect(webPushConfiguration()).toEqual({ on: false, reason: 'missing' });
    production({ WEB_PUSH_VAPID_PUBLIC_KEY: '   ', WEB_PUSH_SUBJECT: 'mailto:support@healthidentitydirectory.com' });
    expect(webPushConfiguration()).toEqual({ on: false, reason: 'missing' });
  });

  it('is on with a valid public key and subject; the key id is the public key\'s', () => {
    production({ WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_SUBJECT: 'mailto:support@healthidentitydirectory.com' });
    expect(webPushConfiguration()).toEqual({ on: true, applicationServerKey: publicKey,
      keyId: webPushKeyId(Buffer.from(publicKey, 'base64url')), subject: 'mailto:support@healthidentitydirectory.com' });
    test({ WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_SUBJECT: 'https://www.healthidentitydirectory.com/contact' });
    expect(webPushConfiguration().on).toBe(true);
  });

  it.each([
    ['too short', 'BAAA'],
    ['88 characters', `${'A'.repeat(88)}`],
    ['not base64url', `${'+'.repeat(87)}`],
    ['first byte not 0x04', (() => { const bytes = Buffer.from(syntheticVapidPublicKey(), 'base64url'); bytes[0] = 3;
      return bytes.toString('base64url'); })()],
    ['not a point on P-256', Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url')],
    ['a private key\'s length', Buffer.alloc(32, 9).toString('base64url')],
  ])('is off (invalid_public_key) for a public key that is %s, and never throws', (_label, value) => {
    production({ WEB_PUSH_VAPID_PUBLIC_KEY: value, WEB_PUSH_SUBJECT: 'mailto:support@healthidentitydirectory.com' });
    expect(() => getEnvironment()).not.toThrow();
    expect(webPushConfiguration()).toEqual({ on: false, reason: 'invalid_public_key' });
  });

  it.each([
    ['http:', 'http://www.healthidentitydirectory.com'],
    ['a bare address', 'support@healthidentitydirectory.com'],
    ['mailto without a domain', 'mailto:support'],
    ['over 256 characters', `mailto:${'a'.repeat(250)}@example.com`],
    ['with spaces', 'mailto:support @example.com'],
    ['https with user info', 'https://user:pass@example.com'],
  ])('is off (invalid_subject) for a subject that is %s', (_label, subject) => {
    test({ WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_SUBJECT: subject });
    expect(webPushConfiguration()).toEqual({ on: false, reason: 'invalid_subject' });
    expect(validVapidSubject(subject)).toBe(false);
  });

  it('never reads a private key: Identity\'s schema has no such key', () => {
    test({ WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_SUBJECT: 'mailto:support@healthidentitydirectory.com',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'should-never-be-read' });
    expect(Object.keys(getEnvironment())).not.toContain('WEB_PUSH_VAPID_PRIVATE_KEY');
    expect(JSON.stringify(webPushConfiguration())).not.toContain('should-never-be-read');
  });

  it('checks a public key on the curve', () => {
    expect(vapidPublicKeyBytes(publicKey)).toHaveLength(65);
    expect(vapidPublicKeyBytes(publicKey.slice(0, 86))).toBeNull();
  });
});
