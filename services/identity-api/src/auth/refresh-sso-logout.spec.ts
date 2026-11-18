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
import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentPatientContextService } from './current-patient-context.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

/**
 * Single sign-on sign-out (ADR-070, 0127) ends sign-ins on other products and
 * other devices with reason `sso_logout` (SsoService.endAccountSignIns and
 * backchannelLogout), and those browsers keep their refresh cookie. Their
 * next refresh is an ordinary ended sign-in: refused and recorded as a denied
 * refresh, never as refresh-token reuse (hid-system#142 relied on main's
 * reason-aware refresh for this). Every other ended session is answered as
 * production answers it today.
 */
const ACCOUNT = '40000000-0000-4000-8000-0000000000a2';
const SESSION = '70000000-0000-4000-8000-0000000000a2';
const FAMILY = '70000000-0000-4000-8000-0000000000b2';
const event = { correlationId: 'refresh-sso-logout-0001' };

function harness(kind: 'staff' | 'patient', revocationReason: string | null) {
  const refreshToken = `${SESSION}.opaque-refresh-secret.${kind === 'staff' ? 'lab.' : ''}local`;
  const row = { id: SESSION, account_id: ACCOUNT, actor_subject: 'synthetic:refresh', family_id: FAMILY,
    access_jti: '71000000-0000-4000-8000-0000000000a2', token_version: '1', authentication_method: 'password',
    session_kind: kind, patient_id: kind === 'patient' ? '50000000-0000-4000-8000-0000000000a2' : null,
    expires_at: new Date(Date.now() + 600_000), absolute_expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: new Date(Date.now() - 60_000), revocation_reason: revocationReason };
  const query = jest.fn(async (sql: string) => (sql.includes('refresh_token_sha256 = $1')
    ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] }));
  const clientQuery = jest.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }));
  const database = { query,
    withSystemTransaction: jest.fn(async (_id: string, work: (client: PoolClient) => unknown) =>
      work({ query: clientQuery } as unknown as PoolClient)) };
  const service = new TokenService(database as unknown as DatabaseService,
    { resolve: jest.fn() } as unknown as CurrentStaffContextService,
    { resolve: jest.fn() } as unknown as CurrentPatientContextService);
  const statements = () => clientQuery.mock.calls.map(([sql, values]) => ({ sql: String(sql), values: values ?? [] }));
  const events = () => statements().filter(({ sql }) => sql.includes('insert into auth.session_events'))
    .map(({ values }) => ({ sessionId: values[0], accountId: values[1], eventType: values[2], outcome: values[3],
      details: JSON.parse(String(values[7])) as Record<string, unknown> }));
  const familyRevoked = () => statements().some(({ sql, values }) => sql.includes('update auth.sessions')
    && sql.includes('family_id = $1') && values[0] === FAMILY);
  return { service, refreshToken, events, familyRevoked, query };
}

describe('refresh of a sign-in that single sign-on sign-out ended', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', STORAGE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
  });
  afterEach(() => resetEnvironmentForTests());

  it.each<'staff' | 'patient'>(['staff', 'patient'])('of a %s is refused as a denied refresh, not as reuse', async (kind) => {
    const { service, refreshToken, events, familyRevoked, query } = harness(kind, 'sso_logout');
    await expect(service.refresh(refreshToken, event)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(String(query.mock.calls[0]?.[0])).toContain('session.revocation_reason');
    expect(events()).toEqual([{ sessionId: SESSION, accountId: ACCOUNT, eventType: 'refresh', outcome: 'denied',
      details: { reason: 'session_ended', revocation_reason: 'sso_logout', session_kind: kind } }]);
    expect(events().some(({ eventType }) => eventType === 'reuse_detected')).toBe(false);
    expect(familyRevoked()).toBe(false);
  });

  // Production's answer for every other ended session is unchanged by single sign-on.
  it.each(['rotated', 'logout', 'refresh_token_reuse', 'password_recovered_with_otp', null])(
    'leaves a session ended by %s answered as before (reuse recorded, the family revoked)', async (reason) => {
      const { service, refreshToken, events, familyRevoked } = harness('staff', reason);
      await expect(service.refresh(refreshToken, event)).rejects.toThrow('Refresh token reuse detected');
      expect(events()).toEqual([expect.objectContaining({ eventType: 'reuse_detected', outcome: 'denied', sessionId: SESSION })]);
      expect(familyRevoked()).toBe(true);
    });
});
