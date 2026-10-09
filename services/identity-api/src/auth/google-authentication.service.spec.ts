jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => ({ source: 'google-jwks' })),
  jwtVerify: jest.fn(),
}));

import type { LoginResult } from './auth.types';
import { UnauthorizedException } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import type { ActorContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import { GoogleAuthenticationService } from './google-authentication.service';
import type { LocalAuthProvider } from './local-auth.provider';
import type { TokenService } from './token.service';
import { jwtVerify } from 'jose';

const verifiedNonce = 'n'.repeat(43);
const token = 'token-'.repeat(8);
const event = { correlationId: 'google-auth-service-test-correlation' };
const actor = { kind: 'patient', patientId: '20000000-0000-4000-8000-000000000001',
  accountId: '10000000-0000-4000-8000-000000000001' } as ActorContext;

function serviceFor(database: Partial<DatabaseService>, tokens: Partial<TokenService> = {},
  localProvider: Partial<LocalAuthProvider> = {}, sessionAudit: Partial<AuthSessionAuditService> = {}) {
  return new GoogleAuthenticationService(database as DatabaseService, tokens as TokenService,
    localProvider as LocalAuthProvider, sessionAudit as AuthSessionAuditService);
}

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
    const service = serviceFor({ query }, { issue });

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
    const service = serviceFor({ query }, { issue });

    await expect(service.login(token, verifiedNonce, 'patient', event))
      .rejects.toMatchObject<Partial<DomainProblem>>({ code: 'GOOGLE_SIGN_IN_DENIED' });
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects nonce mismatch before a mapping lookup', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: 'google-stable-subject', nonce: 'different-nonce-with-at-least-thirty-two-characters', aud: 'google-client-a' },
    } as never);
    const query = jest.fn();
    const service = serviceFor({ query }, { issue: jest.fn() });

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
    const service = serviceFor({ query }, { issue: jest.fn() });

    await expect(service.login(token, verifiedNonce, 'staff', event))
      .rejects.toMatchObject<Partial<DomainProblem>>({ code: 'GOOGLE_SIGN_IN_DENIED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('creates only a short-lived accountless capability for an unknown enrollment subject', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({ payload: {
      sub: 'unknown-google-subject', nonce: verifiedNonce, aud: 'google-client-a',
      email: 'existing-hid-email@example.test',
    } } as never);
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const deadline = new Date(Date.now() + 30 * 60_000);
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ expires_at: deadline }] });
    const withSystemTransaction = jest.fn(async (_correlation: string,
      work: (client: { query: typeof clientQuery }) => Promise<unknown>) => work({ query: clientQuery }));
    const issue = jest.fn();
    const service = serviceFor({ query, withSystemTransaction } as never, { issue });

    const result = await service.exchange(token, verifiedNonce, 'patient', 'enroll', event);
    expect(result).toMatchObject({ kind: 'pending',
      progress: { stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY' } });
    if (result.kind !== 'pending') throw new Error('Expected pending Google onboarding');
    expect(result.cookie).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(issue).not.toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalledWith(
      'select auth.create_google_onboarding_capability($1,$2,$3) as expires_at',
      [expect.any(String), expect.stringMatching(/^[0-9a-f]{64}$/), 'unknown-google-subject'],
    );
    expect(JSON.stringify(clientQuery.mock.calls)).not.toContain('existing-hid-email@example.test');
    expect(JSON.stringify(clientQuery.mock.calls)).not.toContain(result.cookie);
  });

  it('routes a verified Google email conflict to explicit HID linking without merging identities', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({ payload: {
      sub: 'unknown-google-subject', nonce: verifiedNonce, aud: 'google-client-a',
      email: ' Existing@Example.Test ', email_verified: true,
    } } as never);
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ found: true }] });
    const withSystemTransaction = jest.fn();
    const issue = jest.fn();
    const service = serviceFor({ query, withSystemTransaction } as never, { issue });

    await expect(service.exchange(token, verifiedNonce, 'patient', 'enroll', event))
      .rejects.toMatchObject({ code: 'GOOGLE_EXISTING_ACCOUNT_LINK_REQUIRED' });
    expect(query).toHaveBeenNthCalledWith(2,
      expect.stringContaining("status <> 'deleted'"), ['existing@example.test']);
    expect(withSystemTransaction).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('never turns an unknown staff subject into a pending patient identity', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({ payload: {
      sub: 'unknown-google-subject', nonce: verifiedNonce, aud: 'google-client-a',
    } } as never);
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const withSystemTransaction = jest.fn();
    const service = serviceFor({ query, withSystemTransaction } as never);

    await expect(service.exchange(token, verifiedNonce, 'staff', 'enroll', event))
      .rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_DENIED' });
    expect(withSystemTransaction).not.toHaveBeenCalled();
  });

  it('rejects expired or consumed pending capabilities and binds only a hashed cookie token', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const service = serviceFor({ query });
    const cookie = '30000000-0000-4000-8000-000000000001.' + 'A'.repeat(43);
    await expect(service.onboardingStatus(cookie)).rejects.toMatchObject({
      code: 'GOOGLE_ONBOARDING_NOT_FOUND',
    });
    expect(query).toHaveBeenCalledWith(
      'select auth.google_onboarding_capability_status($1,$2) as expires_at',
      ['30000000-0000-4000-8000-000000000001', expect.stringMatching(/^[0-9a-f]{64}$/)],
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain('A'.repeat(43));
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ bool: true }] }) };
    await service.bindPendingInTransaction(client as never, cookie,
      '40000000-0000-4000-8000-000000000001', 'b'.repeat(64));
    await service.consumePendingInTransaction(client as never, cookie,
      '40000000-0000-4000-8000-000000000001', actor.accountId);
    expect(client.query).toHaveBeenNthCalledWith(1,
      'select auth.bind_google_onboarding_capability($1,$2,$3,$4)',
      ['30000000-0000-4000-8000-000000000001', expect.stringMatching(/^[0-9a-f]{64}$/),
        '40000000-0000-4000-8000-000000000001', 'b'.repeat(64)]);
    expect(client.query).toHaveBeenNthCalledWith(2,
      'select auth.consume_google_onboarding_capability($1,$2,$3,$4)',
      ['30000000-0000-4000-8000-000000000001', expect.stringMatching(/^[0-9a-f]{64}$/),
        '40000000-0000-4000-8000-000000000001', actor.accountId]);
  });

  it('links a verified Google subject only after fresh password proof of the same HID account', async () => {
    jest.mocked(jwtVerify).mockResolvedValueOnce({ payload: {
      sub: 'new-google-subject', nonce: verifiedNonce, aud: 'google-client-a',
      email: 'different-person@example.test',
    } } as never);
    const authenticate = jest.fn().mockResolvedValue({ accountId: actor.accountId });
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ bool: true }] });
    const withSystemTransaction = jest.fn(async (_correlation: string,
      work: (client: { query: typeof clientQuery }) => Promise<unknown>) => work({ query: clientQuery }));
    const service = serviceFor({ withSystemTransaction } as never, {}, { authenticate },
      { recordLoginFailure: jest.fn() });

    await service.linkExistingPatient(token, verifiedNonce, 'HID-TESTABC', 'correct-password',
      actor, event);
    expect(authenticate).toHaveBeenCalledWith('HID-TESTABC', 'correct-password', 'patient',
      event.correlationId);
    expect(clientQuery).toHaveBeenCalledWith(
      'select auth.link_google_identity_to_patient_account($1,$2)',
      [actor.accountId, 'new-google-subject']);
    expect(JSON.stringify(clientQuery.mock.calls)).not.toContain('different-person@example.test');
  });

  it('counts failed HID step-up attempts against the existing login lockout', async () => {
    const authenticate = jest.fn().mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    const recordLoginFailure = jest.fn().mockResolvedValue(undefined);
    const service = serviceFor({}, {}, { authenticate }, { recordLoginFailure });

    await expect(service.linkExistingPatient(token, verifiedNonce, 'HID-TESTABC',
      'wrong-password', actor, event)).rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_DENIED' });
    expect(recordLoginFailure).toHaveBeenCalledWith('HID-TESTABC', event);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('rejects valid credentials for another account without linking or comparing Google email', async () => {
    const authenticate = jest.fn().mockResolvedValue({ accountId: 'different-account' });
    const recordLoginFailure = jest.fn().mockResolvedValue(undefined);
    const withSystemTransaction = jest.fn();
    const service = serviceFor({ withSystemTransaction } as never, {}, { authenticate },
      { recordLoginFailure });

    await expect(service.linkExistingPatient(token, verifiedNonce, 'other@example.test',
      'valid-password', actor, event)).rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_DENIED' });
    expect(recordLoginFailure).toHaveBeenCalledWith('other@example.test', event);
    expect(withSystemTransaction).not.toHaveBeenCalled();
    expect(jwtVerify).not.toHaveBeenCalled();
  });
});
