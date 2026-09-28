jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => ({ source: 'google-jwks' })),
  jwtVerify: jest.fn(),
}));

import type { LoginResult } from './auth.types';
import { DomainProblem } from '../common/problem';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { GoogleAuthenticationService } from './google-authentication.service';
import type { TokenService } from './token.service';
import { jwtVerify } from 'jose';

const verifiedNonce = 'n'.repeat(43);
const token = 'token-'.repeat(8);
const event = { correlationId: 'google-auth-service-test-correlation' };

describe('GoogleAuthenticationService', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters',
      GOOGLE_OIDC_CLIENT_IDS: 'google-client-a,google-client-b',
    });
    resetEnvironmentForTests();
    jest.mocked(jwtVerify).mockReset();
  });

  afterEach(() => resetEnvironmentForTests());

  it('uses only a verified Google subject to resolve the existing HID account and patient session', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        sub: 'google-stable-subject',
        nonce: verifiedNonce,
        aud: 'google-client-a',
      },
    } as never);
    const query = jest.fn().mockResolvedValue({
      rows: [{ account_id: '10000000-0000-4000-8000-000000000001', account_subject: 'hid-subject-1' }],
    });
    const issued = { actor: { subject: 'hid-subject-1' } } as LoginResult;
    const issue = jest.fn().mockResolvedValue(issued);
    const service = new GoogleAuthenticationService(
      { query } as unknown as DatabaseService,
      { issue } as unknown as TokenService,
    );

    await expect(service.login(token, verifiedNonce, 'patient', event)).resolves.toBe(issued);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('auth.resolve_google_identity($1)'),
      ['google-stable-subject'],
    );
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'hid-subject-1',
      accountId: '10000000-0000-4000-8000-000000000001',
      actorKind: 'patient',
      authenticationMethod: 'oidc',
    }), event);
    expect(JSON.stringify(query.mock.calls)).not.toContain('email');
  });

  it('denies an unknown or revoked provider subject without issuing an account or patient session', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: 'not-mapped', nonce: verifiedNonce, aud: 'google-client-a' },
    } as never);
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const issue = jest.fn();
    const service = new GoogleAuthenticationService(
      { query } as unknown as DatabaseService,
      { issue } as unknown as TokenService,
    );

    await expect(service.login(token, verifiedNonce, 'patient', event))
      .rejects.toMatchObject<Partial<DomainProblem>>({ code: 'GOOGLE_SIGN_IN_DENIED' });
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects nonce mismatch before a mapping lookup', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: 'google-stable-subject', nonce: 'different-nonce-with-at-least-thirty-two-characters', aud: 'google-client-a' },
    } as never);
    const query = jest.fn();
    const service = new GoogleAuthenticationService(
      { query } as unknown as DatabaseService,
      { issue: jest.fn() } as unknown as TokenService,
    );

    await expect(service.login(token, verifiedNonce, 'staff', event))
      .rejects.toMatchObject<Partial<DomainProblem>>({ code: 'GOOGLE_SIGN_IN_DENIED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a multi-audience token whose authorized party is not an allowed client', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        sub: 'google-stable-subject',
        nonce: verifiedNonce,
        aud: ['google-client-a', 'another-client'],
        azp: 'unapproved-client',
      },
    } as never);
    const query = jest.fn();
    const service = new GoogleAuthenticationService(
      { query } as unknown as DatabaseService,
      { issue: jest.fn() } as unknown as TokenService,
    );

    await expect(service.login(token, verifiedNonce, 'staff', event))
      .rejects.toMatchObject<Partial<DomainProblem>>({ code: 'GOOGLE_SIGN_IN_DENIED' });
    expect(query).not.toHaveBeenCalled();
  });
});
