// Real jose (ESM, loaded through Node's own require) verifies real ES256 and
// RS256 tokens; only the remote key set is replaced by a local one.
jest.mock('jose', () => {
  // process.getBuiltinModule bypasses Jest's module registry, so this is Node's require.
  const { createRequire } = process.getBuiltinModule('node:module');
  const actual = createRequire(`${process.cwd()}/package.json`)('jose') as typeof import('jose');
  return { ...actual, createRemoteJWKSet: jest.fn() };
});

import * as jose from 'jose';
import { resetEnvironmentForTests } from '../config/environment';
import { WorkloadAuthService } from './workload-auth.service';

const issuer = 'https://issuer.test/staging';
const audience = 'hid-notification-api';
const subject = 'hid:staging:identity-api';

describe('Notification WorkloadAuthService token policy (real ES256 and RS256 tokens)', () => {
  let es256: CryptoKey;
  let rs256: CryptoKey;

  beforeAll(async () => {
    const ec = await jose.generateKeyPair('ES256');
    const rsa = await jose.generateKeyPair('RS256');
    es256 = ec.privateKey;
    rs256 = rsa.privateKey;
    // Both keys are published, so only the algorithm policy can refuse RS256.
    const keys = [
      { ...await jose.exportJWK(ec.publicKey), kid: 'es256-key', alg: 'ES256', use: 'sig' },
      { ...await jose.exportJWK(rsa.publicKey), kid: 'rs256-key', alg: 'RS256', use: 'sig' },
    ];
    jest.mocked(jose.createRemoteJWKSet).mockReturnValue(jose.createLocalJWKSet({ keys }) as never);
  });

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', NOTIFICATION_WORKLOAD_IDENTITY_MODE: 'jwt', WORKLOAD_ISSUER_URL: issuer,
      WORKLOAD_JWKS_URL: `${issuer}/.well-known/jwks.json`, WORKLOAD_AUDIENCE: audience,
      IDENTITY_CALLER_SUBJECT: subject,
    });
    resetEnvironmentForTests();
  });

  afterEach(() => resetEnvironmentForTests());

  const now = () => Math.floor(Date.now() / 1000);
  async function token(overrides: Record<string, unknown> = {}, alg: 'ES256' | 'RS256' = 'ES256'): Promise<string> {
    const claims: Record<string, unknown> = { iss: issuer, aud: audience, sub: subject, iat: now(), nbf: now(),
      exp: now() + 300, jti: 'synthetic-jti', token_use: 'workload', ...overrides };
    for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];
    return new jose.SignJWT(claims as jose.JWTPayload)
      .setProtectedHeader({ alg, kid: alg === 'ES256' ? 'es256-key' : 'rs256-key', typ: 'JWT' })
      .sign(alg === 'ES256' ? es256 : rs256);
  }

  it('accepts an issuer-shaped ES256 workload token from Identity', async () => {
    await expect(new WorkloadAuthService().authenticate('identity-api', `Bearer ${await token()}`, undefined))
      .resolves.toBe(subject);
  });

  it.each<[string, () => Promise<string>]>([
    ['no exp', () => token({ exp: undefined })],
    ['an iat older than 300 seconds', () => token({ iat: now() - 400, nbf: now() - 400, exp: now() + 60 })],
    ['an iat in the future', () => token({ iat: now() + 120, nbf: undefined, exp: now() + 420 })],
    ['RS256', () => token({}, 'RS256')],
    ['a token_use other than workload', () => token({ token_use: 'access' })],
    ['no token_use', () => token({ token_use: undefined })],
  ])('refuses a token with %s', async (_label, build) => {
    await expect(new WorkloadAuthService().authenticate('identity-api', `Bearer ${await build()}`, undefined))
      .rejects.toMatchObject({ status: 401 });
  });
});
