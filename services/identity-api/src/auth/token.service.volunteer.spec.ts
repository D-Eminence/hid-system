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
import type { ActorContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CredentialIdentity } from './auth.types';
import type { CurrentPatientContextService } from './current-patient-context.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { VOLUNTEER_SIGN_IN_ELIGIBLE_SQL } from './outreach-volunteer';
import { TokenService } from './token.service';

// Fictional test data only.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = new Date('2026-11-14T09:00:00.000Z');
const outreachOrigin = 'https://outreach.healthidentitydirectory.com';
const volunteer: ActorContext = {
  kind: 'staff', id: 'outreach-volunteer:42000000-0000-4000-8000-000000000001',
  subject: 'outreach-volunteer:42000000-0000-4000-8000-000000000001',
  accountId: '42000000-0000-4000-8000-000000000001', email: 'helper@example.test', displayName: 'Bola Fictional',
  authenticationMethod: 'local', roles: ['outreach_volunteer'], permissions: ['outreach.campaign.read'],
  platformRoles: [], platformPermissions: [], facilityIds: ['11111111-1111-4111-8111-111111111111'], facilities: [],
};
const patientActor: ActorContext = { kind: 'patient', patientId: '51000000-0000-4000-8000-000000000001',
  id: 'patient:41000000-0000-4000-8000-000000000001', subject: 'patient:41000000-0000-4000-8000-000000000001',
  accountId: '41000000-0000-4000-8000-000000000001', roles: [], permissions: [], platformRoles: [],
  platformPermissions: [], facilities: [], facilityIds: [], authenticationMethod: 'local' };

const SWITCH_KEYS = ['OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED', 'OUTREACH_INVITE_LINK_SIGN_IN_ENABLED',
  'AUTH_OUTREACH_VOLUNTEER_REFRESH_TTL_SECONDS', 'AUTH_OUTREACH_VOLUNTEER_ABSOLUTE_TTL_SECONDS',
  'AUTH_REFRESH_TTL_SECONDS', 'AUTH_ABSOLUTE_TTL_SECONDS', 'AUTH_PATIENT_REFRESH_TTL_SECONDS',
  'AUTH_PATIENT_ABSOLUTE_TTL_SECONDS', 'AUTH_OUTREACH_REFRESH_TTL_SECONDS'];

function setEnvironment(extra: Record<string, string> = {}) {
  for (const key of SWITCH_KEYS) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
    CORS_ORIGINS: outreachOrigin, AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', ...extra,
  });
  resetEnvironmentForTests();
}

/**
 * A TokenService over a fake database: `eligible` is what the eligibility
 * query answers (or a thrown error), `oldSession` the stored refresh session.
 */
function harness(options: { eligible?: boolean | Error; oldSession?: Record<string, unknown>;
  principal?: ActorContext } = {}) {
  const clientQuery = jest.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [], rowCount: 1 }));
  const query = jest.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql === VOLUNTEER_SIGN_IN_ELIGIBLE_SQL) {
      if (options.eligible instanceof Error) throw options.eligible;
      return { rows: [{ eligible: options.eligible ?? false }], rowCount: 1 };
    }
    if (sql.includes('from auth.sessions session')) {
      return { rows: options.oldSession ? [options.oldSession] : [], rowCount: options.oldSession ? 1 : 0 };
    }
    return { rows: [{ token_version: '1' }], rowCount: 1 };
  });
  const withSystemTransaction = jest.fn(async (_id: string, work: (client: PoolClient) => Promise<unknown>) =>
    work({ query: clientQuery } as unknown as PoolClient));
  const database = { query, withSystemTransaction };
  const principal = options.principal ?? volunteer;
  const staff = { resolve: jest.fn(async () => principal) };
  const patient = { resolve: jest.fn(async () => patientActor) };
  const service = new TokenService(database as unknown as DatabaseService,
    staff as unknown as CurrentStaffContextService, patient as unknown as CurrentPatientContextService);
  const insertedSession = () => {
    const insert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('insert into auth.sessions'));
    const values = insert?.[1] as unknown[];
    return { expiresAt: values[8] as Date, absoluteExpiresAt: values[9] as Date };
  };
  const eligibilityCalls = () => query.mock.calls.filter(([sql]) => sql === VOLUNTEER_SIGN_IN_ELIGIBLE_SQL);
  const loginEventDetails = () => {
    const event = clientQuery.mock.calls.find(([sql, values]) => String(sql).includes('insert into auth.session_events')
      && (values as unknown[])[2] === 'login_succeeded');
    return JSON.parse(String((event?.[1] as unknown[])[7])) as Record<string, unknown>;
  };
  const sessionEvents = () => clientQuery.mock.calls
    .filter(([sql]) => String(sql).includes('insert into auth.session_events'))
    .map(([, values]) => (values as unknown[])[2]);
  return { service, query, clientQuery, insertedSession, eligibilityCalls, loginEventDetails, sessionEvents };
}

function linkIdentity(deviceTrust?: 'own_device' | 'standard'): CredentialIdentity {
  return { subject: volunteer.subject, accountId: volunteer.accountId, actorKind: 'staff', displayName: '',
    facilities: [], authenticationMethod: 'local', ...(deviceTrust ? { deviceTrust, signInVia: 'invitation_link' as const } : {}) };
}

function stored(kind: 'staff' | 'patient', absoluteExpiresAt: Date, revokedAt: Date | null = null) {
  return { id: '00000000-0000-4000-8000-000000000001',
    account_id: kind === 'patient' ? patientActor.accountId : volunteer.accountId,
    actor_subject: kind === 'patient' ? patientActor.subject : volunteer.subject, family_id: 'family-1',
    access_jti: 'jti', token_version: '1', authentication_method: 'password', session_kind: kind,
    patient_id: kind === 'patient' ? patientActor.patientId : null, revoked_at: revokedAt,
    expires_at: new Date(now.getTime() + HOUR), absolute_expires_at: absoluteExpiresAt };
}

const REFRESH_TOKEN = '00000000-0000-4000-8000-000000000001.secret.local';

beforeEach(() => {
  setEnvironment();
  jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
  for (const key of SWITCH_KEYS) delete process.env[key];
  resetEnvironmentForTests();
});

describe('session lifetimes with both switches off (production today)', () => {
  it('keeps today\'s values: 15 min / 24 h on outreach., 8 h / 24 h elsewhere, patients 7 d / 30 d', async () => {
    const cases: Array<[CredentialIdentity, string | undefined, number, number]> = [
      [linkIdentity('own_device'), outreachOrigin, 15 * MINUTE, DAY],
      [linkIdentity('standard'), outreachOrigin, 15 * MINUTE, DAY],
      [linkIdentity(), outreachOrigin, 15 * MINUTE, DAY],
      [linkIdentity('own_device'), 'https://ehr.healthidentitydirectory.com', 8 * HOUR, DAY],
      [linkIdentity(), undefined, 8 * HOUR, DAY],
    ];
    for (const [identity, origin, idle, absolute] of cases) {
      const { service, insertedSession, eligibilityCalls } = harness({ eligible: true });
      const result = await service.issue(identity, { correlationId: 'off', ...(origin ? { origin } : {}) });
      expect(result.refreshExpiresAt).toEqual(new Date(now.getTime() + idle));
      expect(insertedSession()).toEqual({ expiresAt: new Date(now.getTime() + idle),
        absoluteExpiresAt: new Date(now.getTime() + absolute) });
      // With the switch off the eligibility query is never even asked.
      expect(eligibilityCalls()).toHaveLength(0);
    }
    const patient = harness({ principal: patientActor });
    await patient.service.issue({ subject: patientActor.subject, accountId: patientActor.accountId, actorKind: 'patient',
      displayName: '', facilities: [], authenticationMethod: 'local' }, { correlationId: 'patient', origin: outreachOrigin });
    expect(patient.insertedSession()).toEqual({ expiresAt: new Date(now.getTime() + 7 * DAY),
      absoluteExpiresAt: new Date(now.getTime() + 30 * DAY) });
  });

  it('records the true sign-in method in the login event, and nothing new for an ordinary sign-in', async () => {
    const link = harness({ eligible: true });
    await link.service.issue(linkIdentity('own_device'), { correlationId: 'details', origin: outreachOrigin });
    expect(link.loginEventDetails()).toEqual({ password_upgraded: false, sign_in_via: 'invitation_link',
      device_trust: 'own_device', long_session: false });
    const ordinary = harness();
    const result = await ordinary.service.issue(linkIdentity(), { correlationId: 'ordinary' });
    expect(ordinary.loginEventDetails()).toEqual({ password_upgraded: false });
    expect(result).not.toHaveProperty('longVolunteerSession');
  });
});

describe('session lifetimes with OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED on', () => {
  beforeEach(() => setEnvironment({ OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED: 'true' }));

  it('gives an eligible volunteer on their own phone 7 days idle and 30 days at most', async () => {
    const { service, insertedSession, eligibilityCalls, loginEventDetails } = harness({ eligible: true });
    const result = await service.issue(linkIdentity('own_device'), { correlationId: 'own', origin: outreachOrigin });
    expect(result.refreshExpiresAt).toEqual(new Date(now.getTime() + 7 * DAY));
    expect(result.longVolunteerSession).toBe(true);
    expect(insertedSession()).toEqual({ expiresAt: new Date(now.getTime() + 7 * DAY),
      absoluteExpiresAt: new Date(now.getTime() + 30 * DAY) });
    expect(eligibilityCalls()).toHaveLength(1);
    expect(eligibilityCalls()[0]?.[1]).toEqual([volunteer.accountId, null, ['verified', 'approved', 'active']]);
    expect(loginEventDetails()).toMatchObject({ sign_in_via: 'invitation_link', device_trust: 'own_device', long_session: true });
  });

  it('follows the configured volunteer pair', async () => {
    setEnvironment({ OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED: 'true', AUTH_OUTREACH_VOLUNTEER_REFRESH_TTL_SECONDS: '3600',
      AUTH_OUTREACH_VOLUNTEER_ABSOLUTE_TTL_SECONDS: '172800' });
    const { service, insertedSession } = harness({ eligible: true });
    await service.issue(linkIdentity('own_device'), { correlationId: 'configured', origin: outreachOrigin });
    expect(insertedSession()).toEqual({ expiresAt: new Date(now.getTime() + HOUR),
      absoluteExpiresAt: new Date(now.getTime() + 2 * DAY) });
  });

  it('keeps a shared phone at the 15-minute idle lock and never asks the database', async () => {
    const { service, insertedSession, eligibilityCalls } = harness({ eligible: true });
    const result = await service.issue(linkIdentity('standard'), { correlationId: 'shared', origin: outreachOrigin });
    expect(result.refreshExpiresAt).toEqual(new Date(now.getTime() + 15 * MINUTE));
    expect(result.longVolunteerSession).toBe(false);
    expect(insertedSession()).toEqual({ expiresAt: new Date(now.getTime() + 15 * MINUTE),
      absoluteExpiresAt: new Date(now.getTime() + DAY) });
    expect(eligibilityCalls()).toHaveLength(0);
  });

  it('leaves a login that is not volunteer-only unchanged, also when the check fails', async () => {
    for (const eligible of [false, new Error('database unavailable')]) {
      const { service, insertedSession } = harness({ eligible });
      const result = await service.issue(linkIdentity('own_device'), { correlationId: 'not-eligible', origin: outreachOrigin });
      expect(result.longVolunteerSession).toBe(false);
      expect(insertedSession()).toEqual({ expiresAt: new Date(now.getTime() + 15 * MINUTE),
        absoluteExpiresAt: new Date(now.getTime() + DAY) });
    }
  });

  it('never gives a patient session the volunteer pair', async () => {
    const { service, insertedSession, eligibilityCalls } = harness({ eligible: true, principal: patientActor });
    await service.issue({ subject: patientActor.subject, accountId: patientActor.accountId, actorKind: 'patient',
      displayName: '', facilities: [], authenticationMethod: 'local', deviceTrust: 'own_device' }, { correlationId: 'patient' });
    expect(insertedSession()).toEqual({ expiresAt: new Date(now.getTime() + 7 * DAY),
      absoluteExpiresAt: new Date(now.getTime() + 30 * DAY) });
    expect(eligibilityCalls()).toHaveLength(0);
  });
});

describe('refresh of a long volunteer family', () => {
  const longAbsolute = new Date(now.getTime() + 20 * DAY);

  it('extends a long, eligible family by the volunteer idle time, keeping its absolute expiry', async () => {
    setEnvironment({ OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED: 'true' });
    const { service, insertedSession, eligibilityCalls } = harness({ eligible: true, oldSession: stored('staff', longAbsolute) });
    const result = await service.refresh(REFRESH_TOKEN, { correlationId: 'extend', origin: outreachOrigin });
    expect(result.refreshExpiresAt).toEqual(new Date(now.getTime() + 7 * DAY));
    expect(result.longVolunteerSession).toBe(true);
    expect(insertedSession()).toEqual({ expiresAt: new Date(now.getTime() + 7 * DAY), absoluteExpiresAt: longAbsolute });
    expect(eligibilityCalls()[0]?.[1]).toEqual([volunteer.accountId, null, ['verified', 'approved', 'active']]);
  });

  it('never renews past the family\'s absolute expiry (the last day returns to the short idle cap)', async () => {
    setEnvironment({ OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED: 'true' });
    const absolute = new Date(now.getTime() + 3 * DAY);
    const { service } = harness({ eligible: true, oldSession: stored('staff', absolute) });
    await expect(service.refresh(REFRESH_TOKEN, { correlationId: 'cap', origin: outreachOrigin }))
      .resolves.toMatchObject({ refreshExpiresAt: absolute });
  });

  it.each([
    ['the switch is off', {}, true],
    ['the account was promoted or removed (no longer eligible)', { OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED: 'true' }, false],
  ] as const)('answers 401 and revokes the session when %s', async (_label, environment, eligible) => {
    setEnvironment(environment);
    const { service, clientQuery, sessionEvents } = harness({ eligible, oldSession: stored('staff', longAbsolute) });
    await expect(service.refresh(REFRESH_TOKEN, { correlationId: 'revoke', origin: outreachOrigin }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    const revoked = clientQuery.mock.calls.find(([sql]) => String(sql).includes("coalesce(revocation_reason, 'expired')"));
    expect(revoked?.[1]).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(sessionEvents()).toEqual(['expired']);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('insert into auth.sessions'))).toBe(false);
  });

  it('does not revoke on a database error (the refresh fails and can be tried again)', async () => {
    setEnvironment({ OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED: 'true' });
    const { service, clientQuery } = harness({ eligible: new Error('database unavailable'),
      oldSession: stored('staff', longAbsolute) });
    await expect(service.refresh(REFRESH_TOKEN, { correlationId: 'error' })).rejects.toThrow('database unavailable');
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('leaves ordinary staff and patient families alone and never asks the database', async () => {
    setEnvironment({ OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED: 'true' });
    const staff = harness({ eligible: true, oldSession: stored('staff', new Date(now.getTime() + 20 * HOUR)) });
    await expect(staff.service.refresh(REFRESH_TOKEN, { correlationId: 'staff', origin: outreachOrigin }))
      .resolves.toMatchObject({ refreshExpiresAt: new Date(now.getTime() + 15 * MINUTE) });
    expect(staff.eligibilityCalls()).toHaveLength(0);
    const patient = harness({ eligible: false, principal: patientActor, oldSession: stored('patient', longAbsolute) });
    await expect(patient.service.refresh(REFRESH_TOKEN, { correlationId: 'patient' }))
      .resolves.toMatchObject({ refreshExpiresAt: new Date(now.getTime() + 7 * DAY) });
    expect(patient.eligibilityCalls()).toHaveLength(0);
  });

  it('keeps reuse detection unchanged: a revoked long token revokes the whole family', async () => {
    setEnvironment({ OUTREACH_VOLUNTEER_LONG_SESSION_ENABLED: 'true' });
    const { service, clientQuery, sessionEvents, eligibilityCalls } = harness({ eligible: true,
      oldSession: stored('staff', longAbsolute, new Date(now.getTime() - MINUTE)) });
    await expect(service.refresh(REFRESH_TOKEN, { correlationId: 'reuse' })).rejects.toThrow('Refresh token reuse detected');
    const familyRevoke = clientQuery.mock.calls.find(([sql]) => String(sql).includes("'refresh_token_reuse'"));
    expect(familyRevoke?.[1]).toEqual(['family-1']);
    expect(sessionEvents()).toEqual(['reuse_detected']);
    expect(eligibilityCalls()).toHaveLength(0);
  });
});
