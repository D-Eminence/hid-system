jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: class {
    setProtectedHeader() { return this; }
    setSubject() { return this; }
    setIssuer() { return this; }
    setAudience() { return this; }
    setJti() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'signed-access-token'; }
  },
}));

import { UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { stepUpProblem } from './platform-assurance';
import { classifyPlatformSessionEnd } from './platform-session-end';
import { TokenService } from './token.service';

const ACCOUNT = '40000000-0000-4000-8000-000000000001';
const SUBJECT = 'synthetic:platform-session-end';
const SESSION = '70000000-0000-4000-8000-000000000001';
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ' };
const refreshToken = `${SESSION}.opaque-refresh-secret.local`;

interface Stored { revoked?: boolean; reason?: string | null; lapsed?: boolean }

/**
 * A TokenService whose database answers the session lookups as configured:
 * `active` decides the access-token check, `stored` the platform session state
 * lookup, and `refreshRow` the refresh-token lookup.
 */
function harness(options: { active?: boolean; stored?: Stored; refreshRow?: Record<string, unknown> | null } = {}) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('revocation_reason') && sql.includes("session.session_kind = 'platform'")) {
      const stored = options.stored;
      return stored ? { rowCount: 1, rows: [{ revoked: stored.revoked ?? false, revocation_reason: stored.reason ?? null,
        lapsed: stored.lapsed ?? false }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('session.access_jti = $3')) return { rowCount: options.active ? 1 : 0, rows: [] };
    if (sql.includes('refresh_token_sha256 = $1') && sql.includes('account.token_version = session.account_token_version')) {
      return options.refreshRow ? { rowCount: 1, rows: [options.refreshRow] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('from auth.session_assurance')) return { rowCount: 1, rows: [{}] };
    return { rowCount: 0, rows: [] };
  });
  const clientQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const database = { query,
    withSystemTransaction: jest.fn(async (_id, work) => work({ query: clientQuery } as unknown as PoolClient)) };
  const staff = { resolve: jest.fn(), resolvePlatform: jest.fn() };
  const service = new TokenService(database as unknown as DatabaseService, staff as unknown as CurrentStaffContextService);
  return { service, query, clientQuery };
}

function signed(kind: 'staff' | 'platform') {
  (jwtVerify as jest.Mock).mockResolvedValue({ payload: { sub: SUBJECT, sid: SESSION,
    jti: '71000000-0000-4000-8000-000000000001', auth_method: 'local', token_version: 1, actor_kind: kind } });
}

function storedRefresh(kind: 'staff' | 'platform', state: { revoked?: string; expired?: boolean } = {}) {
  return { id: SESSION, account_id: ACCOUNT, actor_subject: SUBJECT, family_id: SESSION,
    access_jti: '71000000-0000-4000-8000-000000000001', token_version: '1', authentication_method: 'password',
    session_kind: kind, patient_id: null,
    expires_at: new Date(Date.now() + (state.expired ? -60_000 : 600_000)),
    absolute_expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: state.revoked ? new Date(Date.now() - 60_000) : null, revocation_reason: state.revoked ?? null };
}

const problemCode = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return { status: error.getStatus(), code: error.code };
    if (error instanceof UnauthorizedException) return { status: 401, code: 'AUTHENTICATION_REQUIRED' };
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('platform session end codes (Stage 4A)', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', STORAGE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
    (jwtVerify as jest.Mock).mockReset();
  });
  afterEach(() => resetEnvironmentForTests());

  describe('a validly signed platform access token whose session is refused', () => {
    it.each([
      ['an idle or absolute expiry', { lapsed: true }, 'PLATFORM_SESSION_EXPIRED'],
      ['expiry recorded by a refresh attempt', { revoked: true, reason: 'expired' }, 'PLATFORM_SESSION_EXPIRED'],
      ['sign-out', { revoked: true, reason: 'logout' }, 'PLATFORM_SESSION_REVOKED'],
      ['revocation by the administrator', { revoked: true, reason: 'self_revoked' }, 'PLATFORM_SESSION_REVOKED'],
      ['revocation by another administrator', { revoked: true, reason: 'admin_revoked' }, 'PLATFORM_SESSION_REVOKED'],
      ['refresh-token reuse', { revoked: true, reason: 'refresh_token_reuse' }, 'PLATFORM_SESSION_REVOKED'],
      ['account suspension, a credential change or an authenticator reset', {}, 'PLATFORM_SESSION_REVOKED'],
    ])('reports %s', async (_label, stored, code) => {
      signed('platform');
      const { service } = harness({ active: false, stored });
      await expect(problemCode(service.verify('token', 'platform'))).resolves.toEqual({ status: 401, code });
    });

    it('keeps the generic answer for a session replaced by a refresh, so the client refreshes', async () => {
      signed('platform');
      const { service } = harness({ active: false, stored: { revoked: true, reason: 'rotated' } });
      await expect(problemCode(service.verify('token', 'platform')))
        .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    });

    it('keeps the generic answer when no platform session matches the token', async () => {
      signed('platform');
      const { service } = harness({ active: false });
      await expect(problemCode(service.verify('token', 'platform')))
        .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    });

    it('keeps the generic answer, without a lookup, for a platform token presented outside platform routes', async () => {
      signed('platform');
      const { service, query } = harness({ active: false, stored: { revoked: true, reason: 'logout' } });
      await expect(problemCode(service.verify('token'))).resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
      expect(query.mock.calls.some(([sql]) => String(sql).includes('revocation_reason'))).toBe(false);
    });
  });

  it('never classifies a token whose signature or claims fail, and never looks it up', async () => {
    (jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
    const { service, query } = harness({ active: false, stored: { revoked: true, reason: 'logout' } });
    await expect(problemCode(service.verify('forged', 'platform')))
      .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps staff sessions on the generic answer', async () => {
    signed('staff');
    const { service, query } = harness({ active: false, stored: { revoked: true, reason: 'logout' } });
    await expect(problemCode(service.verify('token', 'platform')))
      .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('revocation_reason'))).toBe(false);
  });

  describe('platform refresh', () => {
    it('reports an expired platform session and still records the expiry', async () => {
      const { service, clientQuery } = harness({ refreshRow: storedRefresh('platform', { expired: true }) });
      await expect(problemCode(service.refresh(refreshToken, event, 'platform')))
        .resolves.toEqual({ status: 401, code: 'PLATFORM_SESSION_EXPIRED' });
      expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("'expired'"))).toBe(true);
    });

    it('reports an already expired platform session again without treating it as token reuse', async () => {
      const { service, clientQuery } = harness({ refreshRow: storedRefresh('platform', { revoked: 'expired' }) });
      await expect(problemCode(service.refresh(refreshToken, event, 'platform')))
        .resolves.toEqual({ status: 401, code: 'PLATFORM_SESSION_EXPIRED' });
      expect(clientQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['logout', 'PLATFORM_SESSION_REVOKED'],
      ['admin_revoked', 'PLATFORM_SESSION_REVOKED'],
      ['rotated', 'PLATFORM_SESSION_REVOKED'],
    ])('reports a refresh token already ended by %s, after revoking its family', async (reason, code) => {
      const { service, clientQuery } = harness({ refreshRow: storedRefresh('platform', { revoked: reason }) });
      await expect(problemCode(service.refresh(refreshToken, event, 'platform'))).resolves.toEqual({ status: 401, code });
      expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('refresh_token_reuse'))).toBe(true);
    });

    it('reports a stored platform session whose account was suspended or whose credentials changed', async () => {
      const { service } = harness({ refreshRow: null, stored: { revoked: false } });
      await expect(problemCode(service.refresh(refreshToken, event, 'platform')))
        .resolves.toEqual({ status: 401, code: 'PLATFORM_SESSION_REVOKED' });
    });

    it('keeps the generic answer for an unknown refresh token', async () => {
      const { service } = harness({ refreshRow: null });
      await expect(problemCode(service.refresh(refreshToken, event, 'platform')))
        .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    });

    it('keeps the generic answer for a staff refresh token presented to the platform endpoint', async () => {
      const { service } = harness({ refreshRow: storedRefresh('staff', { expired: true }) });
      await expect(problemCode(service.refresh(refreshToken, event, 'platform')))
        .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    });

    it('keeps staff refresh on the generic answer', async () => {
      const expired = harness({ refreshRow: storedRefresh('staff', { expired: true }) });
      await expect(problemCode(expired.service.refresh(refreshToken, event)))
        .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
      const reused = harness({ refreshRow: storedRefresh('staff', { revoked: 'expired' }) });
      await expect(problemCode(reused.service.refresh(refreshToken, event)))
        .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
      expect(reused.clientQuery.mock.calls.some(([sql]) => String(sql).includes('refresh_token_reuse'))).toBe(true);
      const revoked = harness({ refreshRow: storedRefresh('staff', { revoked: 'logout' }) });
      await expect(problemCode(revoked.service.refresh(refreshToken, event)))
        .resolves.toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    });
  });

  it('classifies stored states without inventing a reason', () => {
    expect(classifyPlatformSessionEnd(undefined)).toBeNull();
    expect(classifyPlatformSessionEnd({ revoked: true, revocationReason: 'rotated', lapsed: true })).toBeNull();
    expect(classifyPlatformSessionEnd({ revoked: true, revocationReason: 'expired', lapsed: false })).toBe('expired');
    expect(classifyPlatformSessionEnd({ revoked: true, revocationReason: null, lapsed: true })).toBe('revoked');
    expect(classifyPlatformSessionEnd({ revoked: false, revocationReason: null, lapsed: true })).toBe('expired');
    expect(classifyPlatformSessionEnd({ revoked: false, revocationReason: null, lapsed: false })).toBe('revoked');
  });
});

describe('step-up refusal codes (Stage 4A)', () => {
  it('distinguishes a session with no step-up from one whose step-up expired', () => {
    expect(stepUpProblem({ stepUpAt: null })).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(stepUpProblem({ stepUpAt: new Date(Date.now() - 600_000) })).toMatchObject({ code: 'STEP_UP_EXPIRED' });
    expect(stepUpProblem({ stepUpAt: null }).getStatus()).toBe(403);
    expect(stepUpProblem({ stepUpAt: new Date() }).getStatus()).toBe(403);
  });
});
