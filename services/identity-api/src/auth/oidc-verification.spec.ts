jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => 'remote-oidc-key-set'),
  jwtVerify: jest.fn(),
  SignJWT: jest.fn(),
}));

import { UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import type { ActorContext } from '../common/request-context';
import { DomainProblem } from '../common/problem';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

// A4: with AUTH_MODE=oidc, a bearer token is checked against the issuer's key
// set. When that key set cannot be fetched (a timeout, a network error, a body
// that is not a key set) every staff request answered 401 and every browser
// signed out, although no token had been refused. An outage now answers 503
// AUTHENTICATION_UNAVAILABLE; a token the key set refuses stays a 401.

const verify = jwtVerify as unknown as jest.Mock;
const actor = { kind: 'staff', subject: 'oidc-subject' } as unknown as ActorContext;

function service() {
  const currentStaff = { resolve: jest.fn(async () => actor) };
  return { tokens: new TokenService({} as DatabaseService, currentStaff as unknown as CurrentStaffContextService), currentStaff };
}

describe('TokenService.verify in OIDC mode (A4)', () => {
  beforeEach(() => {
    verify.mockReset();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER_URL: 'https://issuer.example.test/',
      OIDC_AUDIENCE: 'hid-api',
      OIDC_JWKS_URL: 'https://issuer.example.test/.well-known/jwks.json',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters',
      STORAGE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const key of ['OIDC_ISSUER_URL', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL']) delete process.env[key];
    process.env.AUTH_MODE = 'local';
    resetEnvironmentForTests();
  });

  it.each([
    ['a key-set timeout', Object.assign(new Error('request timed out'), { code: 'ERR_JWKS_TIMEOUT' })],
    ['a network error', new TypeError('fetch failed')],
    ['a body that is not a key set', Object.assign(new Error('JSON Web Key Set malformed'), { code: 'ERR_JWKS_INVALID' })],
  ])('answers %s 503 AUTHENTICATION_UNAVAILABLE, not a 401 that signs the user out', async (_case, fault) => {
    verify.mockRejectedValue(fault);
    const { tokens, currentStaff } = service();
    const refused = await tokens.verify('oidc-token').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DomainProblem);
    expect(refused).toMatchObject({ status: 503, code: 'AUTHENTICATION_UNAVAILABLE' });
    expect(currentStaff.resolve).not.toHaveBeenCalled();
  });

  it('refuses a token the key set does not accept with a 401', async () => {
    verify.mockRejectedValue(Object.assign(new Error('signature verification failed'),
      { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' }));
    const { tokens, currentStaff } = service();
    await expect(tokens.verify('oidc-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(currentStaff.resolve).not.toHaveBeenCalled();
  });

  it('resolves the staff actor of an accepted token, with no MFA assurance', async () => {
    verify.mockResolvedValue({ payload: { sub: 'oidc-subject' } });
    const { tokens, currentStaff } = service();
    await expect(tokens.verify('oidc-token')).resolves.toMatchObject({ actor, mfaAssured: false });
    expect(verify).toHaveBeenCalledWith('oidc-token', 'remote-oidc-key-set', expect.objectContaining({
      issuer: 'https://issuer.example.test/', audience: 'hid-api' }));
    expect(currentStaff.resolve).toHaveBeenCalledWith('oidc-subject', 'oidc');
  });
});
