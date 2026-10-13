jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(async () => ({ payload: {} })),
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

import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { FACILITY_OPTIONAL, PATIENT_ALLOWED, PLATFORM_SCOPE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { useTestEnvironment } from '../testing/platform-assurance';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { SecurityGuard } from './security.guard';
import { TokenService } from './token.service';

/**
 * Every staff session is MFA-verified (launch blocker MFA-1, 0088). A staff
 * session whose family has no live assurance row (a sign-in from before
 * staff MFA, one whose factor was reset) is authorized for nothing, on
 * Identity's routes and on the delegated checks EHR, Lab, Pharmacy, OCR and
 * Outreach make through the same guard, and is ended rather than renewed by
 * refresh. Patient sessions need no assurance. The HTTP runs are in
 * scripts/verify-staff-mfa-runtime.mjs and, for EHR, in
 * ehr-api/scripts/verify-delegated-cookie-read-runtime.mjs.
 */
const FACILITY = '10000000-0000-4000-8000-0000000000e1';
const membership: FacilityAssignment = {
  id: FACILITY, membershipId: '20000000-0000-4000-8000-0000000000e1',
  organizationId: '30000000-0000-4000-8000-0000000000e1', name: 'Facility E', roles: ['doctor'],
  permissions: ['identity.patient.read', 'ehr.encounter.read'], isPrimary: true,
};
const staff: ActorContext = {
  kind: 'staff', id: 'synthetic:staff-e', subject: 'synthetic:staff-e', accountId: '40000000-0000-4000-8000-0000000000e1',
  sessionId: '70000000-0000-4000-8000-0000000000e1', roles: ['doctor'], permissions: membership.permissions,
  platformRoles: [], platformPermissions: [], facilityIds: [FACILITY], facilities: [membership], facility: membership,
  authenticationMethod: 'local',
};
/** A staff actor as CurrentStaffContextService resolves it: no kind. */
const unmarkedStaff: ActorContext = { ...staff, kind: undefined };
const patient: ActorContext = { ...staff, kind: 'patient', patientId: '50000000-0000-4000-8000-0000000000e1',
  facilityIds: [], facilities: [], facility: undefined, roles: [], permissions: [] };

useTestEnvironment();

function reflector(route: { facilityOptional?: boolean; patientAllowed?: boolean; permissions?: string[] }): Reflector {
  return { getAllAndOverride: (key: symbol) => {
    if (key === PLATFORM_SCOPE) return false;
    if (key === FACILITY_OPTIONAL) return route.facilityOptional;
    if (key === PATIENT_ALLOWED) return route.patientAllowed;
    if (key === REQUIRED_PERMISSIONS) return route.permissions;
    return undefined;
  } } as unknown as Reflector;
}

function context(request: HidRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
}

function guardRequest(headers: Record<string, string> = {}): HidRequest {
  const lower: Record<string, string> = { authorization: 'Bearer signed', ...headers };
  return { method: 'GET', correlationId: 'staff-mfa-guard', ip: '192.0.2.30', route: { path: '/identity/patient-lookup' },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function guardFor(route: Parameters<typeof reflector>[0], actor: ActorContext, mfaAssured: boolean | undefined) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  // Runtime controls: portals enabled, maintenance off.
  const database = { query: jest.fn(async (_sql: string, parameters: unknown[]) =>
    ({ rows: [{ enabled: parameters[0] !== 'maintenance_mode' }], rowCount: 1 })) };
  const tokens = { verify: jest.fn().mockResolvedValue({ actor, claims: {}, mfaAssured }), verifyCsrf: jest.fn() };
  const guard = new SecurityGuard(reflector(route), tokens as unknown as TokenService,
    audit as unknown as AuditService, database as unknown as DatabaseService);
  return { guard, audit };
}

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

describe('SecurityGuard: staff sessions need live MFA assurance', () => {
  it.each([
    ['a facility route (patient lookup)', { permissions: ['identity.patient.read'] }],
    ['a facility-optional route (session, delegated service-session)', { facilityOptional: true, patientAllowed: true }],
  ])('refuses a staff session without assurance on %s with 403 STAFF_MFA_REQUIRED, audited', async (_label, route) => {
    for (const actor of [staff, unmarkedStaff]) {
      const { guard, audit } = guardFor(route, actor, false);
      const request = guardRequest({ 'x-facility-id': FACILITY });
      const problem = await refusal(guard.canActivate(context(request)));
      expect(problem.getStatus()).toBe(403);
      expect(problem.code).toBe('STAFF_MFA_REQUIRED');
      // Refused before a facility is bound: recorded against the account, as an auth event.
      expect(request.facilityId).toBeUndefined();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.authorization.denied',
        actorAccountId: staff.accountId, outcome: 'denied' }));
    }
  });

  it('refuses a staff token whose assurance is unknown (OIDC mode, an older verifier) the same way', async () => {
    const { guard } = guardFor({ facilityOptional: true }, staff, undefined);
    expect((await refusal(guard.canActivate(context(guardRequest())))).code).toBe('STAFF_MFA_REQUIRED');
  });

  it('authorizes an MFA-verified staff session as before', async () => {
    const { guard, audit } = guardFor({ permissions: ['identity.patient.read'] }, staff, true);
    const request = guardRequest({ 'x-facility-id': FACILITY });
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.facilityId).toBe(FACILITY);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('asks no assurance of a patient session', async () => {
    const { guard } = guardFor({ facilityOptional: true, patientAllowed: true }, patient, false);
    await expect(guard.canActivate(context(guardRequest()))).resolves.toBe(true);
  });
});

describe('TokenService: staff assurance', () => {
  const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPV' };
  const refreshToken = '70000000-0000-4000-8000-0000000000e1.opaque-refresh-secret.local';

  function sessionRow(kind: 'staff' | 'patient') {
    return { id: '70000000-0000-4000-8000-0000000000e1', account_id: staff.accountId, actor_subject: staff.subject,
      family_id: '70000000-0000-4000-8000-0000000000e0', access_jti: '71000000-0000-4000-8000-0000000000e1',
      token_version: '1', authentication_method: 'password', session_kind: kind,
      patient_id: kind === 'patient' ? patient.patientId : null,
      expires_at: new Date(Date.now() + 600_000), absolute_expires_at: new Date(Date.now() + 3_600_000),
      revoked_at: null, revocation_reason: null };
  }

  function harness(kind: 'staff' | 'patient', assured: boolean) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('from auth.sessions session') && sql.includes('refresh_token_sha256')) {
        return { rows: [sessionRow(kind)], rowCount: 1 };
      }
      if (sql.includes('from auth.session_assurance')) return { rows: assured ? [{}] : [], rowCount: assured ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    });
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const clientQuery = jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: String(sql), values });
      if (String(sql).includes('select token_version::text from auth.accounts')) {
        return { rows: [{ token_version: '1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const database = { query, withSystemTransaction: jest.fn(async (_id: string, work: (client: PoolClient) => unknown) =>
      work({ query: clientQuery } as unknown as PoolClient)) };
    const currentStaff = { resolve: jest.fn().mockResolvedValue(unmarkedStaff) };
    const currentPatient = { resolve: jest.fn().mockResolvedValue(patient) };
    const service = new TokenService(database as unknown as DatabaseService,
      currentStaff as unknown as CurrentStaffContextService, currentPatient as never);
    return { service, query, statements, currentStaff, database };
  }

  it('ends a staff sign-in without assurance on refresh, 403 STAFF_MFA_REQUIRED, and renews nothing', async () => {
    const { service, statements, currentStaff } = harness('staff', false);
    await expect(service.refresh(refreshToken, event)).rejects.toMatchObject({ status: 403, code: 'STAFF_MFA_REQUIRED' });
    expect(currentStaff.resolve).not.toHaveBeenCalled();
    expect(statements.some(({ sql }) => sql.includes('insert into auth.sessions'))).toBe(false);
    // Account lock first (0073), then the whole family, then the refused refresh.
    const lock = statements.findIndex(({ sql }) => sql.includes('auth.lock_account_sessions'));
    const ended = statements.findIndex(({ sql }) => sql.includes("revocation_reason = 'staff_mfa_required'"));
    const recorded = statements.findIndex(({ sql }) => sql.includes('insert into auth.session_events'));
    expect([lock, ended, recorded].every((index) => index >= 0)).toBe(true);
    expect(lock).toBeLessThan(ended);
    expect(ended).toBeLessThan(recorded);
    expect(statements[ended]?.sql).toContain('where family_id = $1 and revoked_at is null');
    expect(statements[ended]?.values).toEqual([sessionRow('staff').family_id]);
    expect(statements[recorded]?.values.slice(2, 4)).toEqual(['refresh', 'denied']);
  });

  it('renews an MFA-verified staff sign-in in its family, which keeps the assurance', async () => {
    const { service, statements } = harness('staff', true);
    const renewed = await service.refresh(refreshToken, event);
    expect(renewed.actor.accountId).toBe(staff.accountId);
    const inserted = statements.find(({ sql }) => sql.includes('insert into auth.sessions'));
    expect(inserted?.values[2]).toBe(sessionRow('staff').family_id);
  });

  it('asks no assurance of a patient refresh', async () => {
    const { service, query } = harness('patient', false);
    await service.refresh(refreshToken, event);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('from auth.session_assurance'))).toBe(false);
  });

  it('reports from the live-session lookup whether the session family has live assurance', async () => {
    (jwtVerify as jest.Mock).mockResolvedValue({ payload: { sub: staff.subject, sid: staff.sessionId,
      jti: '71000000-0000-4000-8000-0000000000e1', auth_method: 'local', token_version: 1, actor_kind: 'staff' } });
    for (const assured of [false, true]) {
      const { service, query } = harness('staff', assured);
      query.mockImplementation(async (sql: string) => (sql.includes('as mfa_assured')
        ? { rows: [{ mfa_assured: assured }], rowCount: 1 } : { rows: [], rowCount: 0 }));
      const verified = await service.verify('signed-access-token');
      expect(verified.mfaAssured).toBe(assured);
      const lookup = String(query.mock.calls.find(([sql]) => String(sql).includes('as mfa_assured'))?.[0]);
      // The assurance is read for any session; only a platform session is refused without it here.
      expect(lookup).toContain("join auth.mfa_factors factor");
      expect(lookup).toContain("factor.status = 'active'");
      expect(lookup).toContain("and (session.session_kind <> 'platform' or exists (");
    }
  });

  it('issues a staff session with the standard lifetimes and its MFA evidence, on the caller\'s transaction', async () => {
    const { service, statements, currentStaff, database } = harness('staff', true);
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: String(sql), values });
      return String(sql).includes('select token_version::text') ? { rows: [{ token_version: '1' }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    }) } as unknown as PoolClient;
    const before = Date.now();
    const issued = await service.issueStaffSession(client, { accountId: staff.accountId, subject: staff.subject,
      factorId: '41000000-0000-4000-8000-0000000000e1', method: 'recovery_code' }, event);
    // Resolved on the transaction's client, which holds the account lock (Stage 7A).
    expect(currentStaff.resolve).toHaveBeenCalledWith(staff.subject, 'local', undefined, undefined, client);
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    expect(issued.expiresAt.getTime() - before).toBeLessThanOrEqual(900_000 + 1_000);
    const session = statements.find(({ sql }) => sql.includes('insert into auth.sessions'));
    expect(session?.values[12]).toBe('staff');
    const assurance = statements.find(({ sql }) => sql.includes('insert into auth.session_assurance'));
    expect(assurance?.values).toEqual([session?.values[0], staff.accountId, '41000000-0000-4000-8000-0000000000e1',
      'recovery_code']);
    const recorded = statements.find(({ sql }) => sql.includes('insert into auth.session_events'));
    expect(JSON.parse(String(recorded?.values[7]))).toEqual({ session_kind: 'staff', mfa_method: 'recovery_code' });
  });
});
