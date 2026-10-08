jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { requireAdminContext } from '../admin/admin-context';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { FACILITY_OPTIONAL, PLATFORM_SCOPE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';

const facilityA = '10000000-0000-4000-8000-00000000000a';
const facilityB = '10000000-0000-4000-8000-00000000000b';

const membership: FacilityAssignment = {
  id: facilityA, membershipId: '40000000-0000-4000-8000-00000000000a',
  organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A',
  roles: ['doctor'], permissions: ['patient.read', 'clinical.encounter.write'], isPrimary: true,
};

const platformAdmin: ActorContext = {
  kind: 'staff', id: 'staff:platform-admin', subject: 'staff:platform-admin',
  accountId: '20000000-0000-4000-8000-000000000001',
  roles: [], permissions: [], platformRoles: ['security_auditor'],
  platformPermissions: ['platform.admin.access', 'platform.audit.read'],
  facilityIds: [facilityA], facilities: [membership], authenticationMethod: 'local',
};

const provider: ActorContext = {
  ...platformAdmin, id: 'staff:provider', subject: 'staff:provider',
  accountId: '20000000-0000-4000-8000-000000000002', platformRoles: [], platformPermissions: [],
};

interface RouteMetadata { platform?: boolean; facilityOptional?: boolean; permissions?: readonly string[] }

function reflector(route: RouteMetadata): Reflector {
  return { getAllAndOverride: (key: symbol) => {
    if (key === PLATFORM_SCOPE) return route.platform;
    if (key === FACILITY_OPTIONAL) return route.facilityOptional;
    if (key === REQUIRED_PERMISSIONS) return route.permissions;
    return undefined;
  } } as unknown as Reflector;
}

function httpRequest(headers: Record<string, string>): HidRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { method: 'GET', correlationId: 'platform-scope-test', ip: '127.0.0.1', route: { path: '/admin/test' },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function executionContext(request: HidRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
}

function guardFor(route: RouteMetadata, actor: ActorContext) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const database = { query: jest.fn(async (_sql: string, parameters: unknown[]) => ({
    rows: [{ enabled: parameters[0] !== 'maintenance_mode' }] })) };
  const tokens = { verify: jest.fn().mockResolvedValue({ actor, claims: {} }) };
  const guard = new SecurityGuard(reflector(route), tokens as unknown as TokenService,
    audit as unknown as AuditService, database as unknown as DatabaseService);
  return { guard, audit };
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

  it('authorizes a platform route without X-Facility-ID and binds no facility', async () => {
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

  it('denies a facility provider without the platform permission on a platform route', async () => {
    const { guard, audit } = guardFor(auditRoute, provider);
    const problem = await denial(guard.canActivate(executionContext(
      httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA }))));
    expect(problem.getStatus()).toBe(403);
    expect(problem.code).toBe('PERMISSION_DENIED');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ accessScope: 'platform', outcome: 'denied' }));
  });

  it('still requires facility context on facility-scoped routes, including for platform administrators', async () => {
    const { guard } = guardFor({ permissions: ['patient.read'] }, platformAdmin);
    const problem = await denial(guard.canActivate(executionContext(httpRequest({ authorization: 'Bearer signed' }))));
    expect(problem.getStatus()).toBe(400);
    expect(problem.code).toBe('FACILITY_REQUIRED');
  });

  it('does not let platform grants satisfy a facility-scoped route', async () => {
    const { guard } = guardFor({ permissions: ['platform.audit.read'] }, platformAdmin);
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facilityA });
    const problem = await denial(guard.canActivate(executionContext(request)));
    expect(problem.getStatus()).toBe(403);
    expect(problem.code).toBe('PERMISSION_DENIED');
    expect(request.accessScope).toBe('facility');
  });

  it('gives a platform administrator no clinical permission at a facility they are not active at', async () => {
    const { guard } = guardFor({ permissions: ['patient.read'] }, platformAdmin);
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

  it('refuses an admin context outside a platform-scoped route', () => {
    const request = httpRequest({});
    Object.assign(request, { actor: platformAdmin, accessScope: 'facility', facilityId: facilityA });
    expect(() => requireAdminContext(request)).toThrow(DomainProblem);
    Object.assign(request, { accessScope: 'platform', facilityId: undefined,
      actor: { ...platformAdmin, platformPermissions: ['platform.audit.read'] } });
    expect(() => requireAdminContext(request)).toThrow('Required permission is missing');
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
