import { generateKeyPairSync } from 'node:crypto';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import { parseSsoConfiguration, ssoClientForRequest, ssoConfiguration, type SsoEnvironment } from './sso-config';

// ADR-070: the relying party's configuration. All unset is off; anything set
// is checked at start-up, and a bad configuration never starts. Every host
// here is fictional.
const ISSUER = 'https://auth.sso-config.invalid';
const LAB = 'lab.sso-config.invalid';
const PORTAL = 'app.sso-config.invalid';
const CORS = `https://${LAB},https://${PORTAL},https://ehr.sso-config.invalid,https://admin.sso-config.invalid`;

const privateJwk = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
  kid: 'lab-client-key' };
const secret = 'synthetic-client-secret-0123456789abcdef';

type Entry = Record<string, unknown>;
const labEntry: Entry = { client_id: 'lab', host: LAB, kind: 'staff', token_endpoint_auth_method: 'private_key_jwt' };
const portalEntry: Entry = { client_id: 'web', host: PORTAL, kind: 'patient', token_endpoint_auth_method: 'client_secret_basic' };

function environment(changes: { entries?: Entry[]; credentials?: Record<string, unknown> } & Partial<SsoEnvironment> = {}): SsoEnvironment {
  const { entries = [labEntry, portalEntry], credentials = { lab: { private_jwk: privateJwk }, web: { client_secret: secret } },
    ...rest } = changes;
  return {
    NODE_ENV: 'test', AUTH_MODE: 'local', CORS_ORIGINS: CORS, AUTH_SSO_ISSUER: ISSUER,
    AUTH_SSO_CLIENTS: JSON.stringify(entries), AUTH_SSO_CLIENT_CREDENTIALS: JSON.stringify(credentials), ...rest,
  };
}

function issues(changes: Parameters<typeof environment>[0]): string {
  return parseSsoConfiguration(environment(changes)).issues.join('\n');
}

describe('single sign-on configuration (ADR-070)', () => {
  it('is off, with nothing to check, when nothing is set', () => {
    expect(parseSsoConfiguration({ NODE_ENV: 'production', AUTH_MODE: 'local', CORS_ORIGINS: CORS }))
      .toEqual({ issues: [] });
    expect(ssoConfiguration({ AUTH_MODE: 'local', CORS_ORIGINS: CORS })).toBeUndefined();
  });

  it('reads a valid registry: each client from its configured host, never from the request', () => {
    const result = parseSsoConfiguration(environment({ NODE_ENV: 'production' }));
    expect(result.issues).toEqual([]);
    const lab = result.configuration!.clients.get('lab')!;
    expect(lab).toMatchObject({ id: 'lab', kind: 'staff', origin: `https://${LAB}`,
      redirectUri: `https://${LAB}/api/v1/auth/sso/callback`, postLogoutRedirectUri: `https://${LAB}/`,
      signInPath: '/provider/sign-in' });
    expect(lab.authentication.method).toBe('private_key_jwt');
    expect(result.configuration!.clients.get('web')).toMatchObject({ kind: 'patient', signInPath: '/sign-in' });
    const configuration = result.configuration!;
    const from = (edge?: string) => ssoClientForRequest(configuration, { header: (name) =>
      (name === 'x-hid-edge-origin' ? edge : undefined) });
    expect(from(`https://${LAB}`)?.id).toBe('lab');
    // Another host, a look-alike, a request without the edge's header: no client.
    for (const edge of ['https://admin.sso-config.invalid', `http://${LAB}`, `https://${LAB}.evil.invalid`, undefined]) {
      expect(from(edge)).toBeUndefined();
    }
  });

  it.each<[string, Parameters<typeof environment>[0], string]>([
    ['administration as a client', { entries: [{ ...labEntry, client_id: 'admin' }], credentials: { admin: { private_jwk: privateJwk } } },
      'platform administration, which is never a single sign-on client'],
    ['the administration host', { entries: [{ ...labEntry, host: 'admin.sso-config.invalid' }] }, 'administration host'],
    ['a staff client of kind patient', { entries: [{ ...labEntry, kind: 'patient' }] }, 'accepts only staff sign-ins, not patient'],
    ['the patient portal of kind staff', { entries: [{ ...portalEntry, kind: 'staff' }], credentials: { web: { client_secret: secret } } },
      'accepts only patient sign-ins, not staff'],
    ['an unknown client', { entries: [{ ...labEntry, client_id: 'billing' }], credentials: { billing: { private_jwk: privateJwk } } },
      'client_id must be one of'],
    ['a wildcard host', { entries: [{ ...labEntry, host: '*.sso-config.invalid' }] }, 'never a wildcard'],
    ['an unknown host', { entries: [{ ...labEntry, host: 'lab.elsewhere.invalid' }] }, 'not a known product host'],
    ['the sign-in site as a client', { entries: [{ ...labEntry, host: 'auth.sso-config.invalid' }],
      CORS_ORIGINS: `${CORS},${ISSUER}` }, 'the sign-in site itself'],
    ['a repeated host', { entries: [labEntry, { ...labEntry, client_id: 'ehr' }],
      credentials: { lab: { private_jwk: privateJwk }, ehr: { private_jwk: privateJwk } } }, 'repeats the host'],
    ['missing credentials', { credentials: { lab: { private_jwk: privateJwk } } }, 'no credential for web'],
    ['a public key instead of a private one', { credentials: { lab: { private_jwk: { ...privateJwk, d: undefined } },
      web: { client_secret: secret } } }, 'one EC P-256 private_jwk with a kid'],
    ['a short client secret', { credentials: { lab: { private_jwk: privateJwk }, web: { client_secret: 'short' } } },
      'at least 32 characters'],
    ['an unknown field', { entries: [{ ...labEntry, redirect_uri: 'https://elsewhere.invalid/cb' }] }, 'unknown field'],
    ['a sign-in page off the host', { entries: [{ ...labEntry, sign_in_path: '//elsewhere.invalid/' }] },
      'sign_in_path must be a page path'],
    ['clients without an issuer', { AUTH_SSO_ISSUER: undefined }, 'require AUTH_SSO_ISSUER'],
    ['an issuer with a path', { AUTH_SSO_ISSUER: `${ISSUER}/oidc` }, 'exact origin'],
    ['OIDC bearer mode', { AUTH_MODE: 'oidc' }, 'requires AUTH_MODE=local'],
  ])('refuses %s in every environment', (_label, changes, message) => {
    expect(issues(changes)).toContain(message);
  });

  it.each<[string, Parameters<typeof environment>[0], string]>([
    ['an http issuer', { AUTH_SSO_ISSUER: 'http://auth.sso-config.invalid' }, 'AUTH_SSO_ISSUER must use HTTPS in production'],
    ['an http internal base', { AUTH_SSO_INTERNAL_BASE_URL: 'http://identity.sso-config.invalid' },
      'AUTH_SSO_INTERNAL_BASE_URL must use HTTPS in production'],
    ['a client host with a port', { entries: [{ ...labEntry, host: `${LAB}:8443` }], CORS_ORIGINS: `${CORS},https://${LAB}:8443` },
      'must not name a port in production'],
    ['an IP address host', { entries: [{ ...labEntry, host: '10.0.0.7' }], CORS_ORIGINS: `${CORS},https://10.0.0.7` },
      'not an IP address'],
  ])('refuses %s in production only', (_label, changes, message) => {
    expect(issues({ ...changes, NODE_ENV: 'production' })).toContain(message);
    expect(issues({ ...changes, NODE_ENV: 'development' })).not.toContain(message);
  });

  it('never echoes a credential in a refusal', () => {
    const text = issues({ credentials: { lab: { private_jwk: { ...privateJwk, crv: 'P-384' } }, web: { client_secret: 'short' } } });
    expect(text).not.toContain(String(privateJwk.d));
    expect(text).not.toContain('short');
  });
});

describe('Identity start-up with single sign-on settings', () => {
  const original = { ...process.env };
  const base = {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: CORS, AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', TURNSTILE_MODE: 'disabled',
  };
  const SSO_KEYS = ['AUTH_SSO_ISSUER', 'AUTH_SSO_INTERNAL_BASE_URL', 'AUTH_SSO_CLIENTS', 'AUTH_SSO_CLIENT_CREDENTIALS'];

  function configure(changes: Record<string, string | undefined>): void {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original, base);
    for (const name of SSO_KEYS) delete process.env[name];
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetEnvironmentForTests();
  }

  afterAll(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('starts as before with the settings unset, and single sign-on is off', () => {
    configure({});
    const environment = getEnvironment();
    for (const name of SSO_KEYS) expect(environment[name as keyof typeof environment]).toBeUndefined();
    expect(ssoConfiguration(environment)).toBeUndefined();
  });

  it('starts with a valid configuration', () => {
    const valid = environment();
    configure({ AUTH_SSO_ISSUER: valid.AUTH_SSO_ISSUER, AUTH_SSO_CLIENTS: valid.AUTH_SSO_CLIENTS,
      AUTH_SSO_CLIENT_CREDENTIALS: valid.AUTH_SSO_CLIENT_CREDENTIALS });
    expect(ssoConfiguration(getEnvironment())?.clients.size).toBe(2);
  });

  it.each<[string, Parameters<typeof environment>[0], string]>([
    ['an http issuer', { AUTH_SSO_ISSUER: 'http://auth.sso-config.invalid' }, 'must use HTTPS in production'],
    ['a wildcard host', { entries: [{ ...labEntry, host: '*.sso-config.invalid' }] }, 'never a wildcard'],
    ['an unknown host', { entries: [{ ...labEntry, host: 'lab.elsewhere.invalid' }] }, 'not a known product host'],
    ['administration as a client', { entries: [{ ...labEntry, client_id: 'admin' }],
      credentials: { admin: { private_jwk: privateJwk } } }, 'never a single sign-on client'],
    ['a staff client of kind patient', { entries: [{ ...labEntry, kind: 'patient' }],
      credentials: { lab: { private_jwk: privateJwk } } }, 'accepts only staff sign-ins'],
  ])('refuses to start in production with %s', (_label, changes, message) => {
    const refused = environment(changes);
    configure({ NODE_ENV: 'production', AUTH_SSO_ISSUER: refused.AUTH_SSO_ISSUER,
      AUTH_SSO_CLIENTS: refused.AUTH_SSO_CLIENTS, AUTH_SSO_CLIENT_CREDENTIALS: refused.AUTH_SSO_CLIENT_CREDENTIALS });
    expect(() => getEnvironment()).toThrow('AUTH_SSO_ISSUER: ');
    expect(() => getEnvironment()).toThrow(message);
  });
});
