jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: class {} }));

import { UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

const ACCOUNT = '40000000-0000-4000-8000-000000000002';
const SESSION = '70000000-0000-4000-8000-000000000002';
const FAMILY = '70000000-0000-4000-8000-0000000000f2';
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPR' };
const refreshToken = `${SESSION}.opaque-refresh-secret.local`;

type Kind = 'staff' | 'patient' | 'platform';

/** A TokenService whose refresh lookup finds one session, revoked with `reason`. */
function harness(kind: Kind, reason: string | null) {
  const row = { id: SESSION, account_id: ACCOUNT, actor_subject: 'synthetic:refresh-reason', family_id: FAMILY,
    access_jti: '71000000-0000-4000-8000-000000000002', token_version: '1', authentication_method: 'password',
    session_kind: kind, patient_id: kind === 'patient' ? '50000000-0000-4000-8000-000000000002' : null,
    expires_at: new Date(Date.now() + 600_000), absolute_expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: new Date(Date.now() - 60_000), revocation_reason: reason };
  const query = jest.fn(async (sql: string) => sql.includes('refresh_token_sha256 = $1')
    && sql.includes('account.token_version = session.account_token_version')
    ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] });
  const clientQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const database = { query,
    withSystemTransaction: jest.fn(async (_id, work) => work({ query: clientQuery } as unknown as PoolClient)) };
  const staff = { resolve: jest.fn(), resolvePlatform: jest.fn() };
  const service = new TokenService(database as unknown as DatabaseService, staff as unknown as CurrentStaffContextService);
  const statements = () => clientQuery.mock.calls.map(([sql, values]) => ({ sql: String(sql), values: values as unknown[] }));
  const events = () => statements().filter(({ sql }) => sql.includes('insert into auth.session_events'))
    .map(({ values }) => ({ eventType: values[2], outcome: values[3], sessionId: values[0], accountId: values[1],
      details: JSON.parse(String(values[7])) as Record<string, unknown> }));
  const familyRevoked = () => statements().some(({ sql, values }) => sql.includes('update auth.sessions')
    && sql.includes('family_id = $1') && values[0] === FAMILY);
  const sessionIssued = () => statements().some(({ sql }) => sql.includes('insert into auth.sessions'));
  return { service, events, familyRevoked, sessionIssued };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error.code;
    if (error instanceof UnauthorizedException) return 'AUTHENTICATION_REQUIRED';
    throw error;
  }
  throw new Error('expected a refusal');
}

// Every revocation reason the backend writes besides rotation (token.service.ts,
// platform-security.service.ts, migrations 0028-0070), plus a missing reason.
const ENDED = ['logout', 'expired', 'refresh_token_reuse', 'platform_admin_revocation', 'self_revoked', 'admin_reset',
  'mfa_reset', 'enrollment_replaced', 'password_recovered_with_otp', 'patient_account_deleted',
  'account_suspended_by_platform_admin', null];

describe('refresh token revocation reasons (Stage 5)', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', STORAGE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
  });
  afterEach(() => resetEnvironmentForTests());

  describe.each<Kind>(['staff', 'patient', 'platform'])('a %s refresh token', (kind) => {
    const scope = kind === 'platform' ? 'platform' : 'standard';

    it.each(ENDED)('of a session ended by %s is refused as a denied refresh, not as reuse', async (reason) => {
      const { service, events, familyRevoked, sessionIssued } = harness(kind, reason);
      const code = await refusal(service.refresh(refreshToken, event, scope));
      expect(code).toBe(kind !== 'platform' ? 'AUTHENTICATION_REQUIRED'
        : reason === 'expired' ? 'PLATFORM_SESSION_EXPIRED' : 'PLATFORM_SESSION_REVOKED');
      expect(familyRevoked()).toBe(false);
      expect(sessionIssued()).toBe(false);
      expect(events()).toEqual([{ eventType: 'refresh', outcome: 'denied', sessionId: SESSION, accountId: ACCOUNT,
        details: { reason: 'session_ended', revocation_reason: reason, session_kind: kind } }]);
    });

    it('that was rotated and is presented again is reuse: its family is revoked and the reuse recorded', async () => {
      const { service, events, familyRevoked, sessionIssued } = harness(kind, 'rotated');
      const code = await refusal(service.refresh(refreshToken, event, scope));
      expect(code).toBe(kind === 'platform' ? 'PLATFORM_SESSION_REVOKED' : 'AUTHENTICATION_REQUIRED');
      expect(familyRevoked()).toBe(true);
      expect(sessionIssued()).toBe(false);
      expect(events()).toEqual([expect.objectContaining({ eventType: 'reuse_detected', outcome: 'denied', sessionId: SESSION })]);
    });
  });
});
