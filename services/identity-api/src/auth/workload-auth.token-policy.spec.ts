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
const audience = 'hid-identity-api';
const subject = 'hid:staging:ehr-api';
const scanner = 'hid:staging:document-scanner';

describe('WorkloadAuthService token policy (real ES256 and RS256 tokens)', () => {
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
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'x'.repeat(32), AUTH_LOGIN_PEPPER: 'y'.repeat(32), STORAGE_MODE: 'disabled',
      IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', WORKLOAD_ISSUER_URL: issuer,
      WORKLOAD_JWKS_URL: `${issuer}/.well-known/jwks.json`, WORKLOAD_AUDIENCE: audience,
      IDENTITY_EHR_CALLER_SUBJECT: subject,
    });
    resetEnvironmentForTests();
  });

  afterEach(() => resetEnvironmentForTests());

  const now = () => Math.floor(Date.now() / 1000);
  async function token(overrides: Record<string, unknown> = {}, alg: 'ES256' | 'RS256' = 'ES256',
    sub = subject): Promise<string> {
    const claims: Record<string, unknown> = { iss: issuer, aud: audience, sub, iat: now(), nbf: now(),
      exp: now() + 300, jti: 'synthetic-jti', token_use: 'workload', ...overrides };
    for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];
    return new jose.SignJWT(claims as jose.JWTPayload)
      .setProtectedHeader({ alg, kid: alg === 'ES256' ? 'es256-key' : 'rs256-key', typ: 'JWT' })
      .sign(alg === 'ES256' ? es256 : rs256);
  }
  const scannerDatabase = { query: jest.fn(async () => ({ rows: [{ account_id: 'scanner-account' }] })) };

  it('accepts an issuer-shaped ES256 workload token for a service and for the scanner', async () => {
    const service = new WorkloadAuthService(scannerDatabase as never);
    await expect(service.authenticateService('ehr-api', `Bearer ${await token()}`, undefined))
      .resolves.toEqual({ subject, accountId: subject });
    await expect(service.authenticateScanner(`Bearer ${await token({}, 'ES256', scanner)}`))
      .resolves.toEqual({ subject: scanner, accountId: 'scanner-account' });
  });

  const refused: Array<[string, () => Promise<string>]> = [
    ['no exp', () => token({ exp: undefined })],
    ['an iat older than 300 seconds', () => token({ iat: now() - 400, nbf: now() - 400, exp: now() + 60 })],
    ['an iat in the future', () => token({ iat: now() + 120, nbf: undefined, exp: now() + 420 })],
    ['RS256', () => token({}, 'RS256')],
    ['a token_use other than workload', () => token({ token_use: 'access' })],
    ['no token_use', () => token({ token_use: undefined })],
  ];

  it.each(refused)('refuses a service token with %s', async (_label, build) => {
    await expect(new WorkloadAuthService({} as never).authenticateService('ehr-api', `Bearer ${await build()}`,
      undefined)).rejects.toMatchObject({ status: 401 });
  });

  it.each(refused)('refuses a scanner token with %s before any account lookup', async (_label, build) => {
    const database = { query: jest.fn(async () => ({ rows: [{ account_id: 'scanner-account' }] })) };
    await expect(new WorkloadAuthService(database as never).authenticateScanner(`Bearer ${await build()}`))
      .rejects.toMatchObject({ status: 401 });
    expect(database.query).not.toHaveBeenCalled();
  });
});
