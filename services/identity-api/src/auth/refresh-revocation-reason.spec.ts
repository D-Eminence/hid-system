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
import { DomainProblem } from '../common/problem';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentPatientContextService } from './current-patient-context.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

const ACCOUNT = '40000000-0000-4000-8000-000000000002';
const SUBJECT = 'synthetic:refresh-reason';
const SESSION = '70000000-0000-4000-8000-000000000002';
const FAMILY = '70000000-0000-4000-8000-0000000000f2';
const PATIENT = '50000000-0000-4000-8000-000000000002';
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPR' };
const refreshToken = `${SESSION}.opaque-refresh-secret.local`;

type Kind = 'staff' | 'patient' | 'platform';

interface HarnessOptions {
  /** The stored session's revocation reason; undefined means the session is live at lookup. */
  revokedAs?: string | null;
  /** The lookup finds no session (the account's token version or status changed). */
  missing?: boolean;
  /** Live at lookup, but the rotation's update finds it ended (a concurrent end), with this reason. */
  endedConcurrentlyAs?: string | null;
}

/** A TokenService over a stub database whose refresh lookup finds one session in the given state. */
function harness(kind: Kind, options: HarnessOptions) {
  const live = options.revokedAs === undefined;
  const row = { id: SESSION, account_id: ACCOUNT, actor_subject: SUBJECT, family_id: FAMILY,
    access_jti: '71000000-0000-4000-8000-000000000002', token_version: '1', authentication_method: 'password',
    session_kind: kind, patient_id: kind === 'patient' ? PATIENT : null,
    expires_at: new Date(Date.now() + 600_000), absolute_expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: live ? null : new Date(Date.now() - 60_000), revocation_reason: live ? null : options.revokedAs };
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('refresh_token_sha256 = $1') && sql.includes('account.token_version = session.account_token_version')) {
      return options.missing ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [row] };
    }
    // The platform lookup that ignores the token version: the stored session still exists.
    if (sql.includes('revocation_reason') && sql.includes("session.session_kind = 'platform'")) {
      return { rowCount: 1, rows: [{ revoked: true, revocation_reason: 'account_suspended_by_platform_admin', lapsed: false }] };
    }
    if (sql.includes('from auth.session_assurance')) return { rowCount: 1, rows: [{}] };
    if (sql.startsWith('select revocation_reason from auth.sessions where id = $1')) {
      return { rowCount: 1, rows: [{ revocation_reason: options.endedConcurrentlyAs ?? null }] };
    }
    return { rowCount: 0, rows: [] };
  });
  const clientQuery = jest.fn(async (sql: string, _values?: unknown[]) =>
    // The rotation's own update: 0 rows when the session ended concurrently.
    (sql.includes("revocation_reason = 'rotated'") && options.endedConcurrentlyAs !== undefined
      ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 }));
  const database = { query,
    withSystemTransaction: jest.fn(async (_id, work) => work({ query: clientQuery } as unknown as PoolClient)) };
  const actor = { id: SUBJECT, subject: SUBJECT, accountId: ACCOUNT, email: null, displayName: null,
    authenticationMethod: 'local', kind, facilities: [], facilityIds: [] };
  const staff = { resolve: jest.fn().mockResolvedValue(actor), resolvePlatform: jest.fn().mockResolvedValue(actor) };
  const patient = { resolve: jest.fn().mockResolvedValue({ ...actor, patientId: PATIENT }) };
  const service = new TokenService(database as unknown as DatabaseService, staff as unknown as CurrentStaffContextService,
    patient as unknown as CurrentPatientContextService);
  const statements = () => clientQuery.mock.calls.map(([sql, values]) => ({ sql: String(sql), values: values ?? [] }));
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

const endCode = (kind: Kind, reason: string | null) => kind !== 'platform' ? 'AUTHENTICATION_REQUIRED'
  : reason === 'expired' ? 'PLATFORM_SESSION_EXPIRED' : 'PLATFORM_SESSION_REVOKED';

// Every reason written to auth.sessions that keeps the account's token version
// (token.service.ts, platform-security.service.ts, 0027 and 0069 revocations),
// plus a missing reason. Account actions that change the token version
// (suspension, MFA reset, password recovery, deletion) are covered separately.
const ENDED = ['logout', 'expired', 'refresh_token_reuse', 'platform_admin_revocation',
  'platform_admin_compromised_session', 'self_revoked', null];

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
      const { service, events, familyRevoked, sessionIssued } = harness(kind, { revokedAs: reason });
      expect(await refusal(service.refresh(refreshToken, event, scope))).toBe(endCode(kind, reason));
      expect(familyRevoked()).toBe(false);
      expect(sessionIssued()).toBe(false);
      expect(events()).toEqual([{ eventType: 'refresh', outcome: 'denied', sessionId: SESSION, accountId: ACCOUNT,
        details: { reason: 'session_ended', revocation_reason: reason, session_kind: kind } }]);
    });

    it('that was rotated and is presented again is reuse: its family is revoked and the reuse recorded', async () => {
      const { service, events, familyRevoked, sessionIssued } = harness(kind, { revokedAs: 'rotated' });
      expect(await refusal(service.refresh(refreshToken, event, scope))).toBe(endCode(kind, 'rotated'));
      expect(familyRevoked()).toBe(true);
      expect(sessionIssued()).toBe(false);
      expect(events()).toEqual([expect.objectContaining({ eventType: 'reuse_detected', outcome: 'denied', sessionId: SESSION })]);
    });

    it('whose account changed token version (suspension, MFA reset, recovery, deletion) is refused without an event', async () => {
      const { service, events, familyRevoked } = harness(kind, { missing: true });
      expect(await refusal(service.refresh(refreshToken, event, scope)))
        .toBe(kind === 'platform' ? 'PLATFORM_SESSION_REVOKED' : 'AUTHENTICATION_REQUIRED');
      expect(familyRevoked()).toBe(false);
      expect(events()).toEqual([]);
    });
  });

  describe.each<'staff' | 'platform'>(['staff', 'platform'])('a %s refresh racing a concurrent session end', (kind) => {
    const scope = kind === 'platform' ? 'platform' : 'standard';

    it.each(['logout', 'expired', 'platform_admin_revocation', 'platform_admin_compromised_session'])(
      'reports an end by %s that committed first as that end, not as reuse', async (reason) => {
        const { service, events, familyRevoked } = harness(kind, { endedConcurrentlyAs: reason });
        expect(await refusal(service.refresh(refreshToken, event, scope))).toBe(endCode(kind, reason));
        expect(familyRevoked()).toBe(false);
        expect(events()).toEqual([{ eventType: 'refresh', outcome: 'denied', sessionId: SESSION, accountId: ACCOUNT,
          details: { reason: 'session_ended', revocation_reason: reason, session_kind: kind } }]);
      });

    it('treats a concurrent rotation of the same token as reuse', async () => {
      const { service, events, familyRevoked } = harness(kind, { endedConcurrentlyAs: 'rotated' });
      expect(await refusal(service.refresh(refreshToken, event, scope))).toBe(endCode(kind, 'rotated'));
      expect(familyRevoked()).toBe(true);
      expect(events()).toEqual([expect.objectContaining({ eventType: 'reuse_detected', outcome: 'denied' })]);
    });
  });
});
