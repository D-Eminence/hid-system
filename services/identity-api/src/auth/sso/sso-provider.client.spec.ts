// Real openid-client and jose (ES modules, loaded through Node's own require,
// as in workload-auth.token-policy.spec.ts): every token here is really
// signed and really checked. The provider is a fake built in this process
// with jose and reached through SSO_HTTP; no network.
jest.mock('openid-client', () => {
  const { createRequire } = process.getBuiltinModule('node:module');
  return createRequire(`${process.cwd()}/package.json`)('openid-client') as typeof import('openid-client');
});
jest.mock('jose', () => {
  const { createRequire } = process.getBuiltinModule('node:module');
  return createRequire(`${process.cwd()}/package.json`)('jose') as typeof import('jose');
});

import { randomBytes } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import { clientKeyPair, createFakeProvider, type FakeProvider } from '../../testing/sso-fake-provider';
import { parseSsoConfiguration, type SsoClient, type SsoConfiguration } from './sso-config';
import { SsoProviderUnavailable, SsoTokenRefused } from './sso-errors';
import { providerAddress, SSO_METADATA_TTL_MS, SsoProviderClient } from './sso-provider.client';
import { pkceChallenge } from './sso-transaction';

const ISSUER = 'https://auth.sso-provider.invalid';
const LAB = 'lab.sso-provider.invalid';
const PORTAL = 'app.sso-provider.invalid';
const INTERNAL = 'https://identity.internal.sso-provider.invalid';
const ACCOUNT = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const DAY = 86_400;

let provider: FakeProvider;
let configuration: SsoConfiguration;
let lab: SsoClient;
let portal: SsoClient;
let offset = 0;
const clock = () => Date.now() + offset;
const now = () => Math.floor(Date.now() / 1_000);
const random = () => randomBytes(32).toString('base64url');

async function setUp(internal = false): Promise<void> {
  const labKeys = await clientKeyPair('lab-client-key');
  const secret = randomBytes(24).toString('hex');
  const parsed = parseSsoConfiguration({
    NODE_ENV: 'test', AUTH_MODE: 'local', CORS_ORIGINS: `https://${LAB},https://${PORTAL}`, AUTH_SSO_ISSUER: ISSUER,
    ...(internal ? { AUTH_SSO_INTERNAL_BASE_URL: INTERNAL } : {}),
    AUTH_SSO_CLIENTS: JSON.stringify([
      { client_id: 'lab', host: LAB, kind: 'staff', token_endpoint_auth_method: 'private_key_jwt' },
      { client_id: 'web', host: PORTAL, kind: 'patient', token_endpoint_auth_method: 'client_secret_basic' },
    ]),
    AUTH_SSO_CLIENT_CREDENTIALS: JSON.stringify({ lab: { private_jwk: labKeys.privateJwk }, web: { client_secret: secret } }),
  });
  expect(parsed.issues).toEqual([]);
  configuration = parsed.configuration!;
  lab = configuration.clients.get('lab')!;
  portal = configuration.clients.get('web')!;
  provider = await createFakeProvider(ISSUER, {
    lab: { kind: 'staff', redirectUri: lab.redirectUri, publicJwk: labKeys.publicJwk },
    web: { kind: 'patient', redirectUri: portal.redirectUri, secret },
  });
  offset = 0;
}

const staffClaims = (extra: JWTPayload = {}): JWTPayload =>
  ({ sub: ACCOUNT, sid: 'provider-session-1', hid_kind: 'staff', amr: ['pwd', 'otp'], ...extra });
const patientClaims = (extra: JWTPayload = {}): JWTPayload =>
  ({ sub: ACCOUNT, sid: 'provider-session-2', hid_kind: 'patient', ...extra });

/**
 * As the browser would: the authorization URL openid-client builds, the
 * provider's sign-in there, then the callback's code exchange. `callback`
 * changes the parameters the provider sends back; `verifier` is the one the
 * relying party presents.
 */
async function signIn(client: SsoClient, claims: JWTPayload, options: {
  rp?: SsoProviderClient; callback?: (parameters: URLSearchParams) => void; verifier?: string; nonce?: string;
} = {}) {
  const rp = options.rp ?? new SsoProviderClient(provider.http, clock);
  const state = random();
  const nonce = random();
  const verifier = random();
  const location = await rp.authorizationUrl(configuration, client, { state, nonce,
    codeChallenge: await pkceChallenge(verifier), maxAgeSeconds: DAY });
  const parameters = new URLSearchParams({ code: provider.authorize(location, claims), state });
  options.callback?.(parameters);
  return rp.completeCodeFlow(configuration, client, parameters,
    { state, nonce: options.nonce ?? nonce, verifier: options.verifier ?? verifier, maxAgeSeconds: DAY });
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** Refused as a token, for the check named (so a test never passes on another failure). */
async function refusedFor(promise: Promise<unknown>, check: string): Promise<void> {
  const error = await refusal(promise);
  expect(error).toBeInstanceOf(SsoTokenRefused);
  expect((error as SsoTokenRefused).reason).toContain(check);
}

const calls = (suffix: string) => provider.calls.filter((call) => call.endsWith(suffix));

beforeEach(() => setUp());

describe('discovery and the key set', () => {
  it('reads discovery once, shares one read between concurrent callers, and reads it again after five minutes', async () => {
    const rp = new SsoProviderClient(provider.http, clock);
    await Promise.all([rp.metadata(configuration), rp.metadata(configuration)]);
    await rp.metadata(configuration);
    expect(calls('/.well-known/openid-configuration')).toHaveLength(1);
    offset = SSO_METADATA_TTL_MS - 1_000;
    await rp.metadata(configuration);
    expect(calls('/.well-known/openid-configuration')).toHaveLength(1);
    offset = SSO_METADATA_TTL_MS + 1;
    await rp.metadata(configuration);
    expect(calls('/.well-known/openid-configuration')).toHaveLength(2);
  });

  it('fails closed: no discovery, and a stale copy is never used once it cannot be read again', async () => {
    const rp = new SsoProviderClient(provider.http, clock);
    provider.down.discovery = true;
    expect(await refusal(rp.metadata(configuration))).toBeInstanceOf(SsoProviderUnavailable);
    provider.down.discovery = false;
    await rp.metadata(configuration);
    provider.down.discovery = true;
    offset = SSO_METADATA_TTL_MS + 1;
    expect(await refusal(rp.metadata(configuration))).toBeInstanceOf(SsoProviderUnavailable);
    expect(await refusal(rp.authorizationUrl(configuration, lab, { state: random(), nonce: random(),
      codeChallenge: random(), maxAgeSeconds: DAY }))).toBeInstanceOf(SsoProviderUnavailable);
  });

  it.each<[string, Record<string, unknown>]>([
    ['another issuer', { issuer: 'https://auth.elsewhere.invalid' }],
    ['the issuer with a trailing slash', { issuer: `${ISSUER}/` }],
    ['a token endpoint off the issuer', { token_endpoint: 'https://collector.elsewhere.invalid/token' }],
    ['an authorization endpoint off the issuer', { authorization_endpoint: 'https://phish.elsewhere.invalid/auth' }],
    ['a key set off the issuer', { jwks_uri: 'https://keys.elsewhere.invalid/jwks' }],
    ['an end-session endpoint off the issuer', { end_session_endpoint: 'https://out.elsewhere.invalid/end' }],
    ['no end-session endpoint', { end_session_endpoint: undefined }],
    ['no PKCE S256', { code_challenge_methods_supported: ['plain'] }],
    ['no code flow', { response_types_supported: ['id_token'] }],
    ['only shared-secret signatures', { id_token_signing_alg_values_supported: ['HS256', 'none'] }],
    ['an answer over 256 KiB', { padding: 'x'.repeat(300 * 1_024) }],
  ])('refuses discovery with %s', async (_label, change) => {
    provider.discovery = change;
    expect(await refusal(new SsoProviderClient(provider.http, clock).metadata(configuration)))
      .toBeInstanceOf(SsoProviderUnavailable);
  });

  it('reaches discovery, the token endpoint and the key set through the internal base, and sends the browser to the public ones', async () => {
    await setUp(true);
    const rp = new SsoProviderClient(provider.http, clock);
    const metadata = await rp.metadata(configuration);
    expect(metadata).toMatchObject({ authorizationEndpoint: `${ISSUER}/auth`, endSessionEndpoint: `${ISSUER}/session/end` });
    await expect(signIn(lab, staffClaims(), { rp })).resolves.toMatchObject({ verified: { accountId: ACCOUNT } });
    expect(provider.calls).toEqual([`GET ${INTERNAL}/.well-known/openid-configuration`, `POST ${INTERNAL}/token`,
      `GET ${INTERNAL}/jwks`]);
    expect(new URL(await rp.endSessionUrl(configuration, lab)).origin).toBe(ISSUER);
  });

  it('checks the ID token against the key set: a rotated key is accepted once discovery is read again', async () => {
    const rp = new SsoProviderClient(provider.http, clock);
    await signIn(lab, staffClaims(), { rp });
    await provider.rotateKey();
    await refusedFor(signIn(lab, staffClaims(), { rp }), 'no applicable keys found');
    offset = SSO_METADATA_TTL_MS + 1;
    await expect(signIn(lab, staffClaims(), { rp })).resolves.toMatchObject({ verified: { accountId: ACCOUNT } });
    expect(calls('/jwks').length).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when the key set cannot be read', async () => {
    provider.down.keys = true;
    expect(await refusal(signIn(lab, staffClaims()))).toBeInstanceOf(SsoProviderUnavailable);
  });
});

describe('the transport', () => {
  it('calls only the issuer\'s own origin, sent to the internal base when one is set', async () => {
    expect(providerAddress(configuration, `${ISSUER}/token?x=1`)).toBe(`${ISSUER}/token?x=1`);
    for (const url of ['https://auth.elsewhere.invalid/token', `http://auth.sso-provider.invalid/token`,
      'https://user:pass@auth.sso-provider.invalid/token', 'https://auth.sso-provider.invalid.elsewhere.invalid/jwks',
      'not a url']) {
      expect(() => providerAddress(configuration, url)).toThrow(SsoProviderUnavailable);
    }
    await setUp(true);
    expect(providerAddress(configuration, `${ISSUER}/jwks`)).toBe(`${INTERNAL}/jwks`);
    expect(() => providerAddress(configuration, `${INTERNAL}/jwks`)).toThrow(SsoProviderUnavailable);
  });
});

describe('the authorization request', () => {
  it('is the code flow with S256 PKCE, state, nonce and max_age, built from discovery and the configured redirect URI', async () => {
    const verifier = random();
    const location = new URL(await new SsoProviderClient(provider.http, clock).authorizationUrl(configuration, lab, {
      state: 's'.repeat(43), nonce: 'n'.repeat(43), codeChallenge: await pkceChallenge(verifier), maxAgeSeconds: DAY,
      prompt: 'login' }));
    expect(location.origin + location.pathname).toBe(`${ISSUER}/auth`);
    expect(Object.fromEntries(location.searchParams)).toEqual({ client_id: 'lab', redirect_uri: lab.redirectUri,
      response_type: 'code', scope: 'openid', state: 's'.repeat(43), nonce: 'n'.repeat(43),
      code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', max_age: String(DAY), prompt: 'login' });
  });
});

describe('the code exchange', () => {
  it('authenticates a private_key_jwt client with a short-lived assertion for the issuer, and sends the verifier', async () => {
    await expect(signIn(lab, staffClaims())).resolves.toMatchObject({ idToken: expect.stringMatching(/^ey/) });
    const form = provider.lastTokenRequest!.form;
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get('redirect_uri')).toBe(`https://${LAB}/api/v1/auth/sso/callback`);
    expect(provider.lastTokenRequest!.authorization).toBeUndefined();
    const assertion = JSON.parse(Buffer.from(form.get('client_assertion')!.split('.')[1]!, 'base64url').toString('utf8'));
    expect(assertion).toMatchObject({ iss: 'lab', sub: 'lab', aud: ISSUER });
    expect(assertion.exp - assertion.iat).toBeLessThanOrEqual(60);
  });

  it('authenticates a client_secret_basic client in the Authorization header only', async () => {
    await expect(signIn(portal, patientClaims())).resolves.toMatchObject({ verified: { accountId: ACCOUNT } });
    expect(provider.lastTokenRequest!.authorization).toMatch(/^Basic /);
    expect(provider.lastTokenRequest!.form.has('client_secret')).toBe(false);
  });

  it('is refused for a verifier that is not the one the code was issued for (PKCE)', async () => {
    expect(await refusal(signIn(lab, staffClaims(), { verifier: random() })))
      .toEqual(new SsoTokenRefused('token endpoint refused the code: invalid_grant'));
  });

  it('is refused for a state that is not the transaction\'s', async () => {
    await refusedFor(signIn(lab, staffClaims(), { callback: (parameters) => parameters.set('state', random()) }),
      '"state" response parameter');
    expect(provider.lastTokenRequest).toBeUndefined();
  });

  it('refuses a callback without the provider\'s issuer, or with another, once the provider announces it (RFC 9207)', async () => {
    provider.discovery = { authorization_response_iss_parameter_supported: true };
    await refusedFor(signIn(lab, staffClaims()), '"iss" (issuer) missing');
    await refusedFor(signIn(lab, staffClaims(), { callback: (parameters) =>
      parameters.set('iss', 'https://auth.elsewhere.invalid') }), '"iss" (issuer) response parameter value');
    await expect(signIn(lab, staffClaims(), { callback: (parameters) => parameters.set('iss', ISSUER) }))
      .resolves.toMatchObject({ verified: { accountId: ACCOUNT } });
  });

  it.each<[string, { status: number; body: unknown }, typeof SsoProviderUnavailable | typeof SsoTokenRefused]>([
    ['a provider outage (502)', { status: 502, body: {} }, SsoProviderUnavailable],
    ['a refused client', { status: 401, body: { error: 'invalid_client' } }, SsoTokenRefused],
    ['an answer without an ID token', { status: 200, body: { access_token: 'x', token_type: 'Bearer' } }, SsoTokenRefused],
  ])('answers %s as it is', async (_label, answer, kind) => {
    provider.tokenAnswer = answer;
    expect(await refusal(signIn(lab, staffClaims()))).toBeInstanceOf(kind);
  });

  it('answers an unreachable token endpoint as unavailable', async () => {
    provider.down.token = true;
    expect(await refusal(signIn(lab, staffClaims()))).toEqual(new SsoProviderUnavailable('unreachable'));
  });
});

describe('ID token checks', () => {
  async function verified(claims: JWTPayload, client: SsoClient = lab, header: Record<string, unknown> = {}) {
    return signIn(client, claims, { callback: () => {
      provider.idTokenHeader = header;
    } });
  }

  it('accepts a staff sign-in with a password and an authenticator code, and a patient sign-in', async () => {
    await expect(verified(staffClaims())).resolves.toMatchObject({ verified: { accountId: ACCOUNT,
      sid: 'provider-session-1', mfaMethod: 'totp', authenticatedAt: expect.any(Date) } });
    await expect(verified(staffClaims({ amr: ['pwd', 'otp', 'hid_recovery_code'] })))
      .resolves.toMatchObject({ verified: { mfaMethod: 'recovery_code' } });
    await expect(verified(patientClaims(), portal)).resolves.not.toHaveProperty('verified.mfaMethod');
  });

  it.each<[string, () => JWTPayload, string]>([
    ['another issuer', () => staffClaims({ iss: 'https://auth.elsewhere.invalid' }), '"iss" (issuer) claim value'],
    ['another audience', () => staffClaims({ aud: 'ehr' }), '"aud" (audience) claim value'],
    ['two audiences without azp', () => staffClaims({ aud: ['lab', 'ehr'] }), 'additional untrusted audiences'],
    ['an azp of another client', () => staffClaims({ azp: 'ehr' }), 'azp'],
    ['an expired token', () => staffClaims({ exp: now() - 120 }), '"exp" (expiration time) claim value'],
    ['an iat in the future', () => staffClaims({ iat: now() + 600, exp: now() + 900 }), 'iat'],
    ['an iat older than five minutes', () => staffClaims({ iat: now() - 600 }), 'iat'],
    ['no sid', () => staffClaims({ sid: undefined }), 'sid'],
    ['a sub that is not an account id', () => staffClaims({ sub: 'synthetic:staff' }), 'sub'],
    ['a patient sign-in for a staff product', () => staffClaims({ hid_kind: 'patient' }), 'kind'],
    ['no kind', () => staffClaims({ hid_kind: undefined }), 'kind'],
    ['no second factor', () => staffClaims({ amr: ['pwd'] }), 'staff_mfa'],
    ['no password', () => staffClaims({ amr: ['otp'] }), 'staff_mfa'],
    ['no amr', () => staffClaims({ amr: undefined }), 'staff_mfa'],
    ['no auth_time', () => staffClaims({ auth_time: undefined }), '"auth_time" (authentication time) claim missing'],
    ['a sign-in older than the absolute lifetime', () => staffClaims({ auth_time: now() - DAY - 120 }),
      'too much time has elapsed'],
    ['a sign-in in the future', () => staffClaims({ auth_time: now() + 600 }), 'auth_time'],
  ])('refuses %s', async (_label, claims, check) => {
    await refusedFor(verified(claims()), check);
  });

  it('refuses another nonce, and no nonce', async () => {
    await refusedFor(signIn(lab, staffClaims(), { nonce: random() }), '"nonce" claim value');
    await refusedFor(signIn(lab, staffClaims({ nonce: undefined })), '"nonce" (nonce) claim missing');
  });

  it('refuses a staff sign-in for the patient portal', async () => {
    await refusedFor(verified(staffClaims(), portal), 'kind');
  });

  it('refuses a token signed by a key the provider does not publish, a shared secret, or no signature', async () => {
    const payload = (nonce: string) => ({ iss: ISSUER, aud: 'lab', nonce, iat: now(), exp: now() + 300,
      auth_time: now(), ...staffClaims() });
    const answers: Array<[(nonce: string) => Promise<string>, string]> = [
      [(nonce) => provider.signLogoutToken({ ...payload(nonce), events: undefined, jti: undefined }, { typ: undefined },
        'stranger'), 'no applicable keys found'],
      [(nonce) => new SignJWT(payload(nonce)).setProtectedHeader({ alg: 'HS256', kid: 'provider-key-1' })
        .sign(new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!')), '"alg" header parameter'],
      [async (nonce) => `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${
        Buffer.from(JSON.stringify(payload(nonce))).toString('base64url')}.`, '"alg" header parameter'],
    ];
    for (const [answer, check] of answers) {
      const rp = new SsoProviderClient(provider.http, clock);
      const nonce = random();
      const verifier = random();
      const state = random();
      const location = await rp.authorizationUrl(configuration, lab, { state, nonce,
        codeChallenge: await pkceChallenge(verifier), maxAgeSeconds: DAY });
      const code = provider.authorize(location, staffClaims());
      provider.tokenAnswer = { status: 200, body: { access_token: 'x', token_type: 'Bearer', id_token: await answer(nonce) } };
      await refusedFor(rp.completeCodeFlow(configuration, lab, new URLSearchParams({ code, state }),
        { state, nonce, verifier, maxAgeSeconds: DAY }), check);
    }
  });
});

describe('the end-session address', () => {
  it('names the client, the product\'s own root and the hint when one is given', async () => {
    const rp = new SsoProviderClient(provider.http, clock);
    const address = new URL(await rp.endSessionUrl(configuration, lab, 'an.id.token'));
    expect(address.origin + address.pathname).toBe(`${ISSUER}/session/end`);
    expect(Object.fromEntries(address.searchParams)).toEqual({ client_id: 'lab', id_token_hint: 'an.id.token',
      post_logout_redirect_uri: `https://${LAB}/` });
    expect(Object.fromEntries(new URL(await rp.endSessionUrl(configuration, portal)).searchParams))
      .toEqual({ client_id: 'web', post_logout_redirect_uri: `https://${PORTAL}/` });
  });
});

describe('logout token checks (Back-Channel Logout 1.0, with jose)', () => {
  const check = (token: string, rp = new SsoProviderClient(provider.http, clock)) =>
    rp.verifyLogoutToken(configuration, lab, token);

  it('accepts a token naming a provider session, or only an account', async () => {
    await expect(check(await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1', sub: ACCOUNT })))
      .resolves.toMatchObject({ sid: 'provider-session-1', accountId: ACCOUNT });
    await expect(check(await provider.signLogoutToken({ aud: 'lab', sub: ACCOUNT })))
      .resolves.toMatchObject({ accountId: ACCOUNT });
    await expect(check(await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1' }, { typ: undefined })))
      .resolves.toMatchObject({ sid: 'provider-session-1' });
  });

  it.each<[string, () => JWTPayload, Record<string, unknown>, string]>([
    ['a nonce', () => ({ aud: 'lab', sid: 'provider-session-1', nonce: 'n' }), {}, 'nonce'],
    ['no back-channel logout event', () => ({ aud: 'lab', sid: 'provider-session-1', events: {} }), {}, 'events'],
    ['another event', () => ({ aud: 'lab', sid: 'provider-session-1', events: { 'https://elsewhere.invalid/event': {} } }),
      {}, 'events'],
    ['neither sid nor sub', () => ({ aud: 'lab' }), {}, 'neither sid nor sub'],
    ['a sub that is not an account id', () => ({ aud: 'lab', sub: 'synthetic:staff' }), {}, 'sub'],
    ['another audience', () => ({ aud: 'ehr', sid: 'provider-session-1' }), {}, 'ERR_JWT_CLAIM_VALIDATION_FAILED'],
    ['an azp of another client', () => ({ aud: 'lab', azp: 'ehr', sid: 'provider-session-1' }), {}, 'azp'],
    ['another issuer', () => ({ aud: 'lab', sid: 'provider-session-1', iss: 'https://auth.elsewhere.invalid' }), {},
      'ERR_JWT_CLAIM_VALIDATION_FAILED'],
    ['an iat older than five minutes', () => ({ aud: 'lab', sid: 'provider-session-1', iat: now() - 600, exp: now() + 60 }),
      {}, 'ERR_JWT_EXPIRED'],
    ['no jti', () => ({ aud: 'lab', sid: 'provider-session-1', jti: undefined }), {}, 'ERR_JWT_CLAIM_VALIDATION_FAILED'],
    ['the type of an ID token', () => ({ aud: 'lab', sid: 'provider-session-1' }), { typ: 'JWT' }, 'typ'],
  ])('refuses a token with %s', async (_label, claims, header, named) => {
    await refusedFor(check(await provider.signLogoutToken(claims(), header)), named);
  });

  it('refuses a token signed by a key the provider does not publish', async () => {
    await refusedFor(check(await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1' }, {}, 'stranger')),
      'ERR_JWKS_NO_MATCHING_KEY');
  });

  it('fails closed when the key set cannot be read', async () => {
    provider.down.keys = true;
    expect(await refusal(check(await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1' }))))
      .toBeInstanceOf(SsoProviderUnavailable);
  });

  it('reads the key set again with discovery, so a rotated key is accepted within five minutes', async () => {
    const rp = new SsoProviderClient(provider.http, clock);
    await check(await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1' }), rp);
    await provider.rotateKey();
    offset = SSO_METADATA_TTL_MS + 1;
    await expect(check(await provider.signLogoutToken({ aud: 'lab', sid: 'provider-session-1' }), rp))
      .resolves.toMatchObject({ sid: 'provider-session-1' });
  });
});
