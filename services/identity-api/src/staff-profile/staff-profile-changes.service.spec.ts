jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Logger, UnauthorizedException } from '@nestjs/common';
import type { AuthSessionAuditService } from '../auth/auth-session-audit.service';
import type { LocalAuthProvider } from '../auth/local-auth.provider';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { SessionRenewal, TokenService } from '../auth/token.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import {
  CHANGE_OWN_DISPLAY_NAME_SQL, CHANGE_OWN_PASSWORD_SQL, CLEAR_LOGIN_ATTEMPTS_SQL, OWN_PASSWORD_ACCOUNT_SQL,
  OWN_PASSWORD_REPLAY_SQL, ownProfileProblem,
} from './staff-profile-changes';
import { StaffProfileChangesService } from './staff-profile-changes.service';

// SX-6 (0205): the service's order of checks and what it hands the database, the token service and the email. The
// database itself is mocked (own-password-and-name.integration.sql runs 0205's functions); the passwords below are
// fictional.

const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const SESSION = '50000000-0000-4000-8000-000000000001';
const JTI = '60000000-0000-4000-8000-000000000001';
const KEY = 'own-password-key-0001';
const CURRENT = 'fictional current passphrase';
const NEW = 'fictional new passphrase';
const STORED = '$argon2id$v=19$m=65536,t=3,p=1$c3RvcmVk$c3RvcmVkLWZpY3Rpb25hbC1oYXNo';

const actor: ActorContext = {
  kind: 'staff', id: 'staff:fictional-ada', subject: 'staff:fictional-ada', accountId: ACCOUNT, sessionId: SESSION,
  displayName: 'Ada Fictional', email: 'ada@example.test', roles: [], permissions: [], facilityIds: [], facilities: [],
  authenticationMethod: 'local',
};

function request(overrides: Partial<HidRequest> = {}): HidRequest {
  const headers: Record<string, string> = { origin: 'https://lab.staging.healthidentitydirectory.com',
    'user-agent': 'Fictional Browser/1.0' };
  return { actor, correlationId: 'own-profile-correlation', accessTokenId: JTI, sessionProduct: 'lab', ip: '192.0.2.10',
    authTransport: 'cookie', header: (name: string) => headers[name.toLowerCase()], ...overrides } as unknown as HidRequest;
}

const changedRow = { change_id: '70000000-0000-4000-8000-000000000001', token_version: '5',
  password_changed_at: new Date('2026-11-26T09:00:00Z'), other_sign_ins_ended: 2,
  session_id: '50000000-0000-4000-8000-000000000002', session_expires_at: new Date('2026-11-26T17:00:00Z'), replayed: false };

function setup(options: { replay?: Record<string, unknown>; account?: Record<string, unknown> | null; locked?: boolean;
  verified?: boolean; changed?: Record<string, unknown> | Error; nameRow?: Record<string, unknown> | Error } = {}) {
  const client = {
    query: jest.fn(async (text: string, _values?: unknown[]) => {
      if (text === OWN_PASSWORD_REPLAY_SQL) return { rows: options.replay ? [options.replay] : [] };
      if (text === CHANGE_OWN_PASSWORD_SQL) {
        if (options.changed instanceof Error) throw options.changed;
        return { rows: [options.changed ?? changedRow] };
      }
      if (text === CHANGE_OWN_DISPLAY_NAME_SQL) {
        if (options.nameRow instanceof Error) throw options.nameRow;
        return { rows: [options.nameRow ?? { profile_version: '2', display_name: 'Ada Bello', replayed: false }] };
      }
      return { rows: [] };
    }),
  };
  const database = {
    query: jest.fn(async (_text: string, _values?: unknown[]) => ({ rows: options.account === null ? [] : [options.account ?? { email: 'Ada@Example.test',
      display_name: 'Dr. Ada Fictional', password_hash: STORED, password_algorithm: 'argon2id' }] })),
    withTransaction: jest.fn(async (_context: unknown, work: (c: typeof client) => Promise<unknown>) => work(client)),
  };
  const renewals: SessionRenewal[] = [];
  const tokens = {
    renewSignIn: jest.fn(async (_presented: unknown, commit: (renewal: SessionRenewal) => Promise<{ tokenVersion: number;
      refreshExpiresAt: Date }>) => {
      const renewal = { sessionId: '50000000-0000-4000-8000-000000000002', accessJti: '60000000-0000-4000-8000-000000000002',
        refreshTokenSha256: 'ab'.repeat(32), refreshExpiresAt: new Date('2026-11-26T18:00:00Z') };
      renewals.push(renewal);
      const renewed = await commit(renewal);
      return { actor, accessToken: `access-v${renewed.tokenVersion}`, refreshToken: 'refresh', csrfToken: 'csrf',
        expiresAt: new Date('2026-11-26T09:15:00Z'), refreshExpiresAt: renewed.refreshExpiresAt };
    }),
  };
  const local = {
    isLockedOut: jest.fn(async () => options.locked === true),
    verifyStoredPassword: jest.fn(async () => options.verified !== false),
    lockoutKey: jest.fn(() => ({ principalHmac: 'h'.repeat(64), pepperVersion: 1 })),
  };
  const sessionAudit = { recordLoginFailure: jest.fn(async () => undefined) };
  const notification = { deliverPasswordUpdated: jest.fn(async () => ({ outcome: 'accepted' })) };
  const service = new StaffProfileChangesService(database as unknown as DatabaseService, tokens as unknown as TokenService,
    local as unknown as LocalAuthProvider, sessionAudit as unknown as AuthSessionAuditService,
    notification as unknown as NotificationOtpClient);
  return { service, client, database, tokens, local, sessionAudit, notification, renewals };
}

/** Every Logger and console method, spied on, so a test can show no password was logged anywhere. */
function spyOnLogs(): () => string {
  const spies = [
    ...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined)),
    ...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((method) =>
      jest.spyOn(Logger, method).mockImplementation(() => undefined)),
    ...(['log', 'info', 'error', 'warn', 'debug', 'trace'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined)),
  ];
  return () => JSON.stringify(spies.map((spy) => spy.mock.calls), (_key, value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message} ${value.stack ?? ''}` : value);
}

afterEach(() => jest.restoreAllMocks());

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return { status: (error as DomainProblem).getStatus(), code: (error as DomainProblem).code };
}

describe('StaffProfileChangesService.changePassword (SX-6)', () => {
  it('changes: the verified hash as the compare-and-swap value, a new argon2id hash, the renewed session\'s digest, the lockout cleared, the email after', async () => {
    const s = setup();
    const changed = await s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY);
    expect(changed.answer).toEqual({ changed: true, otherSignInsEnded: 2, passwordChangedAt: '2026-11-26T09:00:00.000Z',
      replayed: false });
    expect(changed.session).toMatchObject({ accessToken: 'access-v5', refreshExpiresAt: new Date('2026-11-26T17:00:00Z') });
    expect(s.tokens.renewSignIn).toHaveBeenCalledWith({ subject: actor.subject, authenticationMethod: 'local',
      product: 'lab', origin: 'https://lab.staging.healthidentitydirectory.com' }, expect.any(Function));
    expect(s.database.query).toHaveBeenCalledWith(OWN_PASSWORD_ACCOUNT_SQL, [ACCOUNT, actor.subject]);
    expect(s.local.isLockedOut).toHaveBeenCalledWith('Ada@Example.test', 'staff');
    expect(s.local.verifyStoredPassword).toHaveBeenCalledWith(CURRENT, STORED, 'argon2id');
    const call = s.client.query.mock.calls.find(([text]) => text === CHANGE_OWN_PASSWORD_SQL)!;
    const values = call[1] as unknown[];
    expect(values.slice(0, 3)).toEqual([SESSION, JTI, STORED]);
    expect(values[3]).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(values.slice(4)).toEqual([KEY, s.renewals[0]!.sessionId, s.renewals[0]!.accessJti, 'ab'.repeat(32),
      new Date('2026-11-26T18:00:00Z'), '192.0.2.10', 'Fictional Browser/1.0']);
    // No password as given reaches the database, in any call.
    expect(JSON.stringify([...s.client.query.mock.calls, ...s.database.query.mock.calls])).not.toMatch(/fictional (current|new) passphrase/);
    expect(s.client.query).toHaveBeenCalledWith(CLEAR_LOGIN_ATTEMPTS_SQL, ['h'.repeat(64), 1]);
    // The lockout cleared is the account's own email's, as a staff sign-in keys it.
    expect(s.local.lockoutKey).toHaveBeenCalledWith('Ada@Example.test', 'staff');
    expect(s.sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
    await s.service.settleConfirmations();
    expect(s.notification.deliverPasswordUpdated).toHaveBeenCalledWith({ challengeId: changedRow.change_id,
      recipient: 'Ada@Example.test', firstName: 'Ada', correlationId: 'own-profile-correlation' });
  });

  it('the lockout cleared is the one keyed by the account\'s email (the key derived from the argument)', async () => {
    const s = setup({ account: { email: 'Bayo@Example.test', display_name: 'Bayo Fictional', password_hash: STORED,
      password_algorithm: 'argon2id' } });
    s.local.lockoutKey.mockImplementation(((principal: string, kind: string) => ({
      principalHmac: `${kind}:${principal.toLowerCase()}`.padEnd(64, '0'), pepperVersion: 3 })) as never);
    await s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY);
    expect(s.client.query).toHaveBeenCalledWith(CLEAR_LOGIN_ATTEMPTS_SQL, ['staff:bayo@example.test'.padEnd(64, '0'), 3]);
  });

  it('a bcrypt_legacy account: the current password is checked as bcrypt, and the new hash is argon2id', async () => {
    const legacy = '$2b$12$ZmljdGlvbmFsLWxlZ2FjeS1zYWx0LWhhc2gtb2Ytbm90aGluZ3g';
    const s = setup({ account: { email: 'ada@example.test', display_name: 'Ada Fictional', password_hash: legacy,
      password_algorithm: 'bcrypt_legacy' } });
    await s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY);
    expect(s.local.verifyStoredPassword).toHaveBeenCalledWith(CURRENT, legacy, 'bcrypt_legacy');
    const values = s.client.query.mock.calls.find(([text]) => text === CHANGE_OWN_PASSWORD_SQL)![1] as unknown[];
    expect(values[2]).toBe(legacy);
    expect(values[3]).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  });

  it('a sign-in made through single sign-on is renewed as one: the actor\'s oidc reaches renewSignIn', async () => {
    const s = setup();
    await s.service.changePassword(request({ actor: { ...actor, authenticationMethod: 'oidc' } }),
      { currentPassword: CURRENT, newPassword: NEW }, KEY);
    expect(s.tokens.renewSignIn).toHaveBeenCalledWith(expect.objectContaining({ authenticationMethod: 'oidc' }),
      expect.any(Function));
  });

  it('a new password of exactly 12 characters is accepted', async () => {
    const s = setup();
    const changed = await s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: 'twelve chars' },
      KEY);
    expect('twelve chars').toHaveLength(12);
    expect(changed.answer.changed).toBe(true);
    expect(s.tokens.renewSignIn).toHaveBeenCalledTimes(1);
  });

  it('no password in any log, in a success and in each refusal', async () => {
    const logged = spyOnLogs();
    const ok = setup();
    ok.notification.deliverPasswordUpdated.mockRejectedValueOnce(new Error('notification down'));
    await ok.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY);
    await ok.service.settleConfirmations();
    await refusal(setup({ verified: false }).service.changePassword(request(),
      { currentPassword: 'wrong fictional pass', newPassword: NEW }, KEY));
    await refusal(setup().service.changePassword(request(), { currentPassword: CURRENT, newPassword: 'short pass' }, KEY));
    await refusal(setup({ changed: Object.assign(new Error('terminating connection'), { code: '57P01' }) }).service
      .changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY));
    const failing = setup();
    failing.database.query.mockRejectedValueOnce(new Error('connection reset'));
    await refusal(failing.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY));
    const seen = logged();
    for (const password of [CURRENT, NEW, 'wrong fictional pass', 'short pass']) expect(seen).not.toContain(password);
  });

  it.each([
    ['the account read', (s: ReturnType<typeof setup>) => s.database.query.mockRejectedValueOnce(
      Object.assign(new Error('terminating connection'), { code: '57P01' }))],
    ['the lockout read', (s: ReturnType<typeof setup>) => s.local.isLockedOut.mockRejectedValueOnce(new Error('pool ended'))],
    ['counting a wrong password', (s: ReturnType<typeof setup>) => {
      s.local.verifyStoredPassword.mockResolvedValueOnce(false);
      s.sessionAudit.recordLoginFailure.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }));
    }],
    ['the current password check', (s: ReturnType<typeof setup>) => s.local.verifyStoredPassword.mockRejectedValueOnce(
      new Error('verifier failed'))],
  ])('%s failing: 503 DEPENDENCY_UNAVAILABLE (not a 500), nothing changed', async (_label, arrange) => {
    const s = setup();
    arrange(s);
    expect(await refusal(s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY)))
      .toEqual({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    expect(s.tokens.renewSignIn).not.toHaveBeenCalled();
  });

  it('a replay of the key answers the stored change first: no password checked, nothing counted, no cookie, no email', async () => {
    const s = setup({ replay: { ...changedRow, token_version: null, session_expires_at: null, replayed: true } });
    const changed = await s.service.changePassword(request(), { currentPassword: 'no longer right', newPassword: NEW }, KEY);
    expect(changed).toEqual({ answer: { changed: true, otherSignInsEnded: 2, passwordChangedAt: '2026-11-26T09:00:00.000Z',
      replayed: true }, changeId: changedRow.change_id });
    expect(s.client.query).toHaveBeenCalledWith(OWN_PASSWORD_REPLAY_SQL, [KEY]);
    expect(s.database.query).not.toHaveBeenCalled();
    expect(s.local.verifyStoredPassword).not.toHaveBeenCalled();
    expect(s.tokens.renewSignIn).not.toHaveBeenCalled();
    await s.service.settleConfirmations();
    expect(s.notification.deliverPasswordUpdated).not.toHaveBeenCalled();
  });

  it('no password: 409 PASSWORD_NOT_SET before the lock or the password is looked at', async () => {
    const s = setup({ account: { email: 'ada@example.test', display_name: null, password_hash: null, password_algorithm: null } });
    expect(await refusal(s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY)))
      .toEqual({ status: 409, code: 'PASSWORD_NOT_SET' });
    expect(s.local.isLockedOut).not.toHaveBeenCalled();
    expect(s.local.verifyStoredPassword).not.toHaveBeenCalled();
    expect(s.sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
  });

  it('locked: 429 STAFF_REAUTHENTICATION_LOCKED, the password not checked and nothing counted', async () => {
    const s = setup({ locked: true });
    expect(await refusal(s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY)))
      .toEqual({ status: 429, code: 'STAFF_REAUTHENTICATION_LOCKED' });
    expect(s.local.verifyStoredPassword).not.toHaveBeenCalled();
    expect(s.sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
  });

  it('a wrong current password counts towards the lockout and answers 403 STAFF_REAUTHENTICATION_FAILED', async () => {
    const s = setup({ verified: false });
    expect(await refusal(s.service.changePassword(request(), { currentPassword: 'wrong fictional pass', newPassword: NEW }, KEY)))
      .toEqual({ status: 403, code: 'STAFF_REAUTHENTICATION_FAILED' });
    expect(s.sessionAudit.recordLoginFailure).toHaveBeenCalledWith('Ada@Example.test', { correlationId: 'own-profile-correlation',
      actorSubject: actor.subject, sourceIp: '192.0.2.10', userAgent: 'Fictional Browser/1.0' });
    expect(s.tokens.renewSignIn).not.toHaveBeenCalled();
  });

  it('an account with no email cannot be checked (no lockout key): 403, nothing counted', async () => {
    const s = setup({ account: { email: null, display_name: null, password_hash: STORED, password_algorithm: 'argon2id' } });
    expect(await refusal(s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY)))
      .toEqual({ status: 403, code: 'STAFF_REAUTHENTICATION_FAILED' });
    expect(s.local.verifyStoredPassword).not.toHaveBeenCalled();
    expect(s.sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
  });

  it('after the current password: PASSWORD_TOO_SHORT under 12, PASSWORD_SAME_AS_CURRENT, nothing changed', async () => {
    const s = setup();
    expect(await refusal(s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: 'elevenchars' }, KEY)))
      .toEqual({ status: 400, code: 'PASSWORD_TOO_SHORT' });
    expect(await refusal(s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: CURRENT }, KEY)))
      .toEqual({ status: 400, code: 'PASSWORD_SAME_AS_CURRENT' });
    expect(s.local.verifyStoredPassword).toHaveBeenCalledTimes(2);
    expect(s.tokens.renewSignIn).not.toHaveBeenCalled();
  });

  it('a session without a token id (not Identity\'s own) is 401 before anything is read', async () => {
    const s = setup();
    expect(await refusal(s.service.changePassword(request({ accessTokenId: undefined }),
      { currentPassword: CURRENT, newPassword: NEW }, KEY))).toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(s.database.withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['42501', 'OWN_SESSION_NOT_CURRENT', 401, 'AUTHENTICATION_REQUIRED'],
    ['42501', 'OWN_ACCOUNT_NOT_ACTIVE', 401, 'AUTHENTICATION_REQUIRED'],
    ['42501', 'STAFF_PROFILE_CHANGE_NOT_ALLOWED', 403, 'STAFF_PROFILE_CHANGE_NOT_ALLOWED'],
    ['55000', 'PASSWORD_NOT_SET', 409, 'PASSWORD_NOT_SET'],
    ['40001', 'PASSWORD_CHANGED_MEANWHILE', 409, 'PASSWORD_CHANGED_MEANWHILE'],
    ['22023', 'PASSWORD_HASH_INVALID', 503, 'DEPENDENCY_UNAVAILABLE'],
    ['08006', 'connection failure', 503, 'DEPENDENCY_UNAVAILABLE'],
  ])('the database\'s %s %s answers %s %s, and no email is sent', async (sqlstate, message, status, code) => {
    const s = setup({ changed: Object.assign(new Error(message), { code: sqlstate }) });
    expect(await refusal(s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY)))
      .toEqual({ status, code });
    await s.service.settleConfirmations();
    expect(s.notification.deliverPasswordUpdated).not.toHaveBeenCalled();
  });

  it('a session that no longer fits its site (the renewal\'s 401) answers 401 AUTHENTICATION_REQUIRED', async () => {
    const s = setup();
    s.tokens.renewSignIn.mockRejectedValueOnce(new UnauthorizedException('Session no longer fits this site'));
    expect(await refusal(s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY)))
      .toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
  });

  it('the same key committed first by a concurrent request: its change is answered as a replay, no cookie, no email', async () => {
    const s = setup({ changed: { ...changedRow, token_version: null, session_expires_at: null, replayed: true } });
    const changed = await s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY);
    expect(changed).toEqual({ answer: expect.objectContaining({ replayed: true }), changeId: changedRow.change_id });
    expect(s.client.query).not.toHaveBeenCalledWith(CLEAR_LOGIN_ATTEMPTS_SQL, expect.anything());
    await s.service.settleConfirmations();
    expect(s.notification.deliverPasswordUpdated).not.toHaveBeenCalled();
  });

  it('a failed email never fails the change', async () => {
    const s = setup();
    s.notification.deliverPasswordUpdated.mockRejectedValueOnce(new Error('notification down'));
    const changed = await s.service.changePassword(request(), { currentPassword: CURRENT, newPassword: NEW }, KEY);
    expect(changed.answer.changed).toBe(true);
    await s.service.settleConfirmations();
  });
});

describe('StaffProfileChangesService.changeName (SX-6)', () => {
  it('trims the name, checks it by the invitee rule, and hands 0205 the name, version, key and session', async () => {
    const s = setup();
    expect(await s.service.changeName(request(), { name: '  Ada Bello ', expectedVersion: 1 }, KEY))
      .toEqual({ replayed: false, profileVersion: 2 });
    expect(s.client.query).toHaveBeenCalledWith(CHANGE_OWN_DISPLAY_NAME_SQL,
      ['Ada Bello', 1, KEY, SESSION, '192.0.2.10', 'Fictional Browser/1.0']);
  });

  it.each(['Dr. Ada', 'Ada', 'Ada Support', 'Ada Bello1', 'Ada Health ID'])('refuses %p with 400 STAFF_NAME_INVALID before the database', async (name) => {
    const s = setup();
    expect(await refusal(s.service.changeName(request(), { name, expectedVersion: 1 }, KEY)))
      .toEqual({ status: 400, code: 'STAFF_NAME_INVALID' });
    expect(s.database.withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['40001', 'VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['55000', 'STAFF_NAME_CHANGE_LIMITED', 429, 'STAFF_NAME_CHANGE_LIMITED'],
    ['22023', 'STAFF_NAME_UNCHANGED', 400, 'STAFF_NAME_UNCHANGED'],
    ['22023', 'STAFF_NAME_INVALID', 400, 'STAFF_NAME_INVALID'],
    ['23505', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['42501', 'STAFF_PROFILE_CHANGE_NOT_ALLOWED', 403, 'STAFF_PROFILE_CHANGE_NOT_ALLOWED'],
    ['42501', 'OWN_SESSION_NOT_CURRENT', 401, 'AUTHENTICATION_REQUIRED'],
  ])('the database\'s %s %s answers %s %s', async (sqlstate, message, status, code) => {
    const s = setup({ nameRow: Object.assign(new Error(message), { code: sqlstate }) });
    expect(await refusal(s.service.changeName(request(), { name: 'Ada Bello', expectedVersion: 1 }, KEY)))
      .toEqual({ status, code });
  });

  it('a replay says so', async () => {
    const s = setup({ nameRow: { profile_version: '2', display_name: 'Ada Bello', replayed: true } });
    expect(await s.service.changeName(request(), { name: 'Ada Bello', expectedVersion: 1 }, KEY))
      .toEqual({ replayed: true, profileVersion: 2 });
  });
});

describe('ownProfileProblem', () => {
  it('never answers a database message it does not know', () => {
    const problem = ownProfileProblem(Object.assign(new Error('relation "auth.secret" does not exist'), { code: '42P01' }));
    expect(problem.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(problem.message).not.toContain('auth.secret');
  });
});
