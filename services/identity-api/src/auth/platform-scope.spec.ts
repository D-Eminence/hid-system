jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { requireAdminContext } from '../admin/admin-context';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { FACILITY_OPTIONAL, HIGH_RISK_ACTION, PATIENT_ALLOWED, PLATFORM_SCOPE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { assuranceResult, isAssuranceQuery, PLATFORM_SESSION_ID, platformActor } from '../testing/platform-assurance';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';

const facilityA = '10000000-0000-4000-8000-00000000000a';
const facilityB = '10000000-0000-4000-8000-00000000000b';

const membership: FacilityAssignment = {
  id: facilityA, membershipId: '40000000-0000-4000-8000-00000000000a',
  organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A',
  roles: ['doctor'], permissions: ['patient.read', 'clinical.encounter.write'], isPrimary: true,
};

/** A platform administration session (password + TOTP), no facility. */
const platformAdmin: ActorContext = platformActor({
  id: 'staff:platform-admin', subject: 'staff:platform-admin', platformRoles: ['security_auditor'],
  platformPermissions: ['platform.admin.access', 'platform.audit.read'],
});

/** The same administrator's ordinary staff session at their facility. */
const staffSessionOfAdmin: ActorContext = {
  ...platformAdmin, kind: 'staff', sessionId: '90000000-0000-4000-8000-0000000000a1',
  facilityIds: [facilityA], facilities: [membership],
};

const provider: ActorContext = {
  ...staffSessionOfAdmin, id: 'staff:provider', subject: 'staff:provider',
  accountId: '20000000-0000-4000-8000-000000000002', platformRoles: [], platformPermissions: [],
};

const patient: ActorContext = {
  ...provider, kind: 'patient', patientId: '50000000-0000-4000-8000-000000000001', facilityIds: [], facilities: [],
};

interface RouteMetadata {
  platform?: boolean; facilityOptional?: boolean; patientAllowed?: boolean;
  permissions?: readonly string[]; highRiskAction?: string;
}

function reflector(route: RouteMetadata): Reflector {
  return { getAllAndOverride: (key: symbol) => {
    if (key === PLATFORM_SCOPE) return route.platform;
    if (key === FACILITY_OPTIONAL) return route.facilityOptional;
    if (key === PATIENT_ALLOWED) return route.patientAllowed;
    if (key === REQUIRED_PERMISSIONS) return route.permissions;
    if (key === HIGH_RISK_ACTION) return route.highRiskAction;
    return undefined;
  } } as unknown as Reflector;
}

function httpRequest(headers: Record<string, string>, options: { method?: string; body?: unknown;
  query?: Record<string, string>; cookies?: Record<string, string> } = {}): HidRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { method: options.method ?? 'GET', correlationId: 'platform-scope-test', ip: '127.0.0.1',
    route: { path: '/admin/test' }, body: options.body, query: options.query ?? {}, cookies: options.cookies,
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function executionContext(request: HidRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
}

function guardFor(route: RouteMetadata, actor: ActorContext, assurance: { stepUpFresh?: boolean; active?: boolean } = {}) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const database = { query: jest.fn(async (sql: string, parameters: unknown[]) => isAssuranceQuery(sql)
    ? assuranceResult(assurance)
    : { rows: [{ enabled: parameters[0] !== 'maintenance_mode' }] }) };
  const tokens = { verify: jest.fn().mockResolvedValue({ actor, claims: {} }),
    verifyCsrf: jest.fn((_claims, cookie: string | undefined, header: string | undefined) =>
      Boolean(cookie) && cookie === header) };
  const guard = new SecurityGuard(reflector(route), tokens as unknown as TokenService,
    audit as unknown as AuditService, database as unknown as DatabaseService);
  return { guard, audit, tokens, database };
}

async function denial(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local', STORAGE_MODE: 'disabled',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});
afterEach(() => resetEnvironmentForTests());

describe('Platform administration scope', () => {
  const auditRoute = { platform: true, permissions: ['platform.audit.read'] };

  it('authorizes a platform session on a platform route without X-Facility-ID and binds no facility', async () => {
    const { guard, audit } = guardFor(auditRoute, platformAdmin);
    const request = httpRequest({ authorization: 'Bearer signed' });
    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(request.accessScope).toBe('platform');
    expect(request.facilityId).toBeUndefined();
    expect(request.actor?.facility).toBeUndefined();
    expect(request.actor?.permissions).toEqual([]);
    expect(request.actor?.roles).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();

    const context = requireAdminContext(request);
    expect(context).toMatchObject({ scope: 'platform', facilityId: null, membershipId: null,
      purposeOfUse: 'healthcare-operations' });
    expect(context.actor.sessionId).toBe(PLATFORM_SESSION_ID);
  });

  it('ignores a supplied X-Facility-ID on a platform route instead of borrowing that membership', async () => {
    const { guard } = guardFor(auditRoute, platformAdmin);
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA });
    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(request.facilityId).toBeUndefined();
    expect(request.actor?.permissions).toEqual([]);
  });

  it('accepts only platform grants on a platform route; facility permissions cannot satisfy it', async () => {
    const { guard, audit } = guardFor({ platform: true, permissions: ['patient.read'] }, platformAdmin);
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA });
    const problem = await denial(guard.canActivate(executionContext(request)));
    expect(problem.getStatus()).toBe(403);
    expect(problem.code).toBe('PERMISSION_DENIED');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'staff', actorSubject: platformAdmin.subject, accessScope: 'platform', outcome: 'denied',
    }));
    const recorded = audit.record.mock.calls[0][0] as Record<string, unknown>;
    expect(recorded.facilityId).toBeUndefined();
    expect(recorded.actorMembershipId).toBeUndefined();
  });

  it.each([
    ['a staff session of a platform administrator', staffSessionOfAdmin],
    ['a facility provider session', provider],
  ])('refuses %s on a platform route with platform-scoped evidence', async (_label, actor) => {
    const { guard, audit } = guardFor(auditRoute, actor);
    const problem = await denial(guard.canActivate(executionContext(
      httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA }))));
    expect(problem.getStatus()).toBe(403);
    expect(problem.code).toBe('PLATFORM_SESSION_REQUIRED');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ accessScope: 'platform', outcome: 'denied',
      details: expect.objectContaining({ code: 'PLATFORM_SESSION_REQUIRED' }) }));
  });

  it('refuses a patient session on a platform route', async () => {
    const { guard } = guardFor(auditRoute, patient);
    const problem = await denial(guard.canActivate(executionContext(httpRequest({ authorization: 'Bearer signed' }))));
    expect(problem.code).toBe('PATIENT_SCOPE_DENIED');
  });

  it.each([
    ['a facility route', { permissions: ['patient.read'] }],
    ['a facility-optional route', { facilityOptional: true, patientAllowed: true }],
  ])('refuses a platform session on %s', async (_label, route) => {
    const { guard } = guardFor(route, platformAdmin);
    const problem = await denial(guard.canActivate(executionContext(
      httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA }))));
    expect(problem.getStatus()).toBe(403);
    expect(problem.code).toBe('PLATFORM_SESSION_SCOPE_DENIED');
  });

  it('still requires facility context on facility-scoped routes for staff sessions of administrators', async () => {
    const { guard } = guardFor({ permissions: ['patient.read'] }, staffSessionOfAdmin);
    const problem = await denial(guard.canActivate(executionContext(httpRequest({ authorization: 'Bearer signed' }))));
    expect(problem.getStatus()).toBe(400);
    expect(problem.code).toBe('FACILITY_REQUIRED');
  });

  it('does not let platform grants satisfy a facility-scoped route', async () => {
    const { guard } = guardFor({ permissions: ['platform.audit.read'] }, staffSessionOfAdmin);
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA });
    const problem = await denial(guard.canActivate(executionContext(request)));
    expect(problem.getStatus()).toBe(403);
    expect(problem.code).toBe('PERMISSION_DENIED');
    expect(request.accessScope).toBe('facility');
  });

  it('gives a platform administrator no clinical permission at a facility they are not active at', async () => {
    const { guard } = guardFor({ permissions: ['patient.read'] }, staffSessionOfAdmin);
    const problem = await denial(guard.canActivate(executionContext(
      httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityB }))));
    expect(problem.getStatus()).toBe(403);
    expect(problem.code).toBe('FACILITY_ACCESS_DENIED');
  });

  it('keeps the bound membership permissions for a facility-scoped clinical route', async () => {
    const { guard } = guardFor({ permissions: ['patient.read'] }, provider);
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA });
    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(request.facilityId).toBe(facilityA);
    expect(request.accessScope).toBe('facility');
    expect(request.actor?.permissions).toEqual(membership.permissions);
  });

  it('reads only the platform cookie on platform routes and only the staff cookie elsewhere', async () => {
    const cookies = { hid_access: 'staff-token', hid_access_admin: 'platform-token' };
    const platform = guardFor(auditRoute, platformAdmin);
    await platform.guard.canActivate(executionContext(httpRequest({}, { cookies })));
    expect(platform.tokens.verify).toHaveBeenCalledWith('platform-token');
    const facility = guardFor({ permissions: ['patient.read'] }, provider);
    await facility.guard.canActivate(executionContext(httpRequest({ 'x-facility-id': facilityA }, { cookies })));
    expect(facility.tokens.verify).toHaveBeenCalledWith('staff-token');
  });

  it('checks platform cookie mutations against the platform CSRF cookie', async () => {
    const route = { platform: true, permissions: ['platform.admin.access'], highRiskAction: 'platform.mfa.step-up' };
    const { guard } = guardFor(route, platformAdmin);
    const staffCsrf = httpRequest({ origin: 'http://localhost:5173', 'x-csrf-token': 'csrf-a' },
      { method: 'POST', body: {}, cookies: { hid_access_admin: 'platform-token', hid_access_csrf: 'csrf-a' } });
    expect((await denial(guard.canActivate(executionContext(staffCsrf)))).code).toBe('CSRF_VALIDATION_FAILED');
    const platformCsrf = httpRequest({ origin: 'http://localhost:5173', 'x-csrf-token': 'csrf-a' },
      { method: 'POST', body: {}, cookies: { hid_access_admin: 'platform-token', hid_access_admin_csrf: 'csrf-a' } });
    await expect(guard.canActivate(executionContext(platformCsrf))).resolves.toBe(true);
  });

  it('refuses an admin context outside a platform-scoped route or from a non-platform session', () => {
    const request = httpRequest({});
    Object.assign(request, { actor: platformAdmin, accessScope: 'facility', facilityId: facilityA });
    expect(() => requireAdminContext(request)).toThrow(DomainProblem);
    Object.assign(request, { accessScope: 'platform', facilityId: undefined,
      actor: { ...platformAdmin, platformPermissions: ['platform.audit.read'] } });
    expect(() => requireAdminContext(request)).toThrow('Required permission is missing');
    Object.assign(request, { actor: staffSessionOfAdmin });
    expect(() => requireAdminContext(request)).toThrow('An MFA-verified platform administration session is required');
  });
});

describe('Central high-risk policy in the guard', () => {
  const critical = { platform: true, permissions: ['platform.role.manage'], highRiskAction: 'platform.role.change' };
  const superAdmin = platformActor();
  const roleChange = (headers: Record<string, string> = {}, body: unknown = { reason: 'Governed role change' }) =>
    httpRequest({ authorization: 'Bearer signed', 'if-match': '"3"', 'idempotency-key': 'guard-policy-key-0001', ...headers },
      { method: 'POST', body });

  it('refuses a platform mutation that declares no registered policy', async () => {
    const undeclared = guardFor({ platform: true, permissions: ['platform.role.manage'] }, superAdmin);
    expect((await denial(undeclared.guard.canActivate(executionContext(roleChange())))).code)
      .toBe('HIGH_RISK_POLICY_MISSING');
    const unknown = guardFor({ ...critical, highRiskAction: 'platform.unknown' }, superAdmin);
    expect((await denial(unknown.guard.canActivate(executionContext(roleChange())))).code)
      .toBe('HIGH_RISK_POLICY_MISSING');
  });

  it('requires a fresh server-side step-up for a critical action whatever the client claims', async () => {
    const { guard } = guardFor(critical, superAdmin, { stepUpFresh: false });
    const forged = roleChange({ 'x-step-up': 'true', 'x-mfa-verified': 'true' },
      { reason: 'Governed role change', stepUp: true, mfaVerified: true });
    const problem = await denial(guard.canActivate(executionContext(forged)));
    expect(problem.getStatus()).toBe(403);
    expect(problem.code).toBe('STEP_UP_REQUIRED');
  });

  it('allows a critical action after a fresh step-up and records the action on the request', async () => {
    const { guard } = guardFor(critical, superAdmin);
    const request = roleChange();
    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(request.highRiskAction).toBe('platform.role.change');
  });

  it.each([
    ['If-Match', { 'if-match': '' }, undefined, 428, 'IF_MATCH_REQUIRED'],
    ['Idempotency-Key', { 'idempotency-key': 'short' }, undefined, 400, 'IDEMPOTENCY_KEY_REQUIRED'],
    ['reason', {}, { reason: 'short' }, 400, 'REASON_REQUIRED'],
  ] as const)('refuses a critical action without %s', async (_label, headers, body, status, code) => {
    const { guard } = guardFor(critical, superAdmin);
    const problem = await denial(guard.canActivate(executionContext(roleChange(headers, body))));
    expect(problem.getStatus()).toBe(status);
    expect(problem.code).toBe(code);
  });

  it('requires the policy permission even when the route declares fewer', async () => {
    const { guard } = guardFor({ ...critical, permissions: [] },
      platformActor({ platformPermissions: ['platform.admin.access'] }));
    expect((await denial(guard.canActivate(executionContext(roleChange())))).code).toBe('PERMISSION_DENIED');
  });

  it('requires step-up for high-tier actions but not for standard-tier actions', async () => {
    const high = guardFor({ platform: true, permissions: ['platform.facility.manage'],
      highRiskAction: 'platform.facility.status' }, superAdmin, { stepUpFresh: false });
    expect((await denial(high.guard.canActivate(executionContext(roleChange())))).code).toBe('STEP_UP_REQUIRED');
    const standard = guardFor({ platform: true, permissions: ['platform.demo.manage'],
      highRiskAction: 'platform.demo-request.status' }, superAdmin, { stepUpFresh: false });
    await expect(standard.guard.canActivate(executionContext(roleChange({ 'idempotency-key': '' }))))
      .resolves.toBe(true);
  });

  it('requires step-up and a reason for a principal export (GET)', async () => {
    const route = { platform: true, permissions: ['platform.principal.export'],
      highRiskAction: 'platform.principals.export' };
    const stale = guardFor(route, superAdmin, { stepUpFresh: false });
    const exportRequest = httpRequest({ authorization: 'Bearer signed' }, { query: { reason: 'Quarterly review' } });
    expect((await denial(stale.guard.canActivate(executionContext(exportRequest)))).code).toBe('STEP_UP_REQUIRED');
    const fresh = guardFor(route, superAdmin);
    expect((await denial(fresh.guard.canActivate(executionContext(httpRequest({ authorization: 'Bearer signed' })))))
      .code).toBe('REASON_REQUIRED');
    await expect(fresh.guard.canActivate(executionContext(exportRequest))).resolves.toBe(true);
    const support = guardFor({ ...route, permissions: ['platform.principal.read'] },
      platformActor({ platformPermissions: ['platform.admin.access', 'platform.principal.read', 'platform.session.revoke'] }));
    expect((await denial(support.guard.canActivate(executionContext(exportRequest)))).code).toBe('PERMISSION_DENIED');
  });

  it('treats a session whose assurance is gone as no platform session', async () => {
    const { guard } = guardFor(critical, superAdmin, { active: false });
    expect((await denial(guard.canActivate(executionContext(roleChange())))).code).toBe('PLATFORM_SESSION_REQUIRED');
  });
});

describe('Platform-scoped audit persistence', () => {
  const platformEvent = {
    correlationId: 'platform-audit-test', actorType: 'staff' as const, actorSubject: platformAdmin.subject,
    actorAccountId: platformAdmin.accountId, accessScope: 'platform' as const,
    action: 'admin.audit.list', resourceType: 'audit-event-collection', outcome: 'success' as const,
  };

  it('writes a facility-less staff row marked as platform scope', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await new AuditService({ query } as unknown as DatabaseService).record(platformEvent);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('access_scope');
    expect(parameters[1]).toBe('staff');
    expect(parameters[4]).toBeNull();
    expect(parameters[6]).toBeNull();
    expect(parameters[19]).toBe('platform');
  });

  it.each([
    ['a facility', { facilityId: facilityA }],
    ['a facility membership', { actorMembershipId: membership.membershipId }],
    ['no account', { actorAccountId: undefined }],
    ['a non-staff actor', { actorType: 'system' as const }],
  ])('refuses a platform-scoped row with %s', async (_label, override) => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(new AuditService({ query } as unknown as DatabaseService).record({ ...platformEvent, ...override }))
      .rejects.toThrow('Platform audit events require a staff account without facility context');
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps the facility requirement for staff rows that are not platform-scoped', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const { accessScope: _scope, ...facilityEvent } = platformEvent;
    await expect(new AuditService({ query } as unknown as DatabaseService).record(facilityEvent))
      .rejects.toThrow('Staff audit events require a resolved facility context');
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when the database refuses a platform-scoped row', async () => {
    const query = jest.fn().mockRejectedValue(new Error('AUDIT_PLATFORM_SCOPE_DENIED'));
    await expect(new AuditService({ query } as unknown as DatabaseService).record(platformEvent))
      .rejects.toThrow('Audit persistence is unavailable; request was denied');
  });
});

describe('Platform-scoped request audit', () => {
  function intercept(request: HidRequest) {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AuditInterceptor({ getAllAndOverride: () => undefined } as unknown as Reflector,
      audit as unknown as AuditService);
    const handler: CallHandler = { handle: () => of({ ok: true }) };
    return { audit, result: lastValueFrom(interceptor.intercept(executionContext(request), handler)) };
  }

  it('records a platform request without a facility', async () => {
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA });
    Object.assign(request, { actor: { ...platformAdmin, permissions: [], facility: undefined }, accessScope: 'platform' });
    const { audit, result } = intercept(request);
    await expect(result).resolves.toEqual({ ok: true });
    const recorded = audit.record.mock.calls[0][0] as Record<string, unknown>;
    expect(recorded).toMatchObject({ actorType: 'staff', accessScope: 'platform', outcome: 'success' });
    expect(recorded.facilityId).toBeUndefined();
    expect(recorded.actorMembershipId).toBeUndefined();
  });

  it('keeps facility attribution for facility-scoped requests', async () => {
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA });
    Object.assign(request, { actor: { ...provider, facility: membership }, accessScope: 'facility', facilityId: facilityA });
    const { audit, result } = intercept(request);
    await result;
    const recorded = audit.record.mock.calls[0][0] as Record<string, unknown>;
    expect(recorded).toMatchObject({ facilityId: facilityA, actorMembershipId: membership.membershipId });
    expect(recorded.accessScope).toBeUndefined();
  });
});
