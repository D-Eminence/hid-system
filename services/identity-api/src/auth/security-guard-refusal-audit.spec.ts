jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { type ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AuditService } from '../audit/audit.service';
import {
  FACILITY_OPTIONAL, HIGH_RISK_ACTION, PATIENT_ALLOWED, PATIENT_ONLY, PLATFORM_SCOPE, REQUIRED_PERMISSIONS,
} from '../common/decorators';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import {
  type AssuranceOptions, assuranceResult, isAssuranceQuery, platformActor, useTestEnvironment,
} from '../testing/platform-assurance';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';

// A17: SecurityGuard recorded the refusal code only on platform routes, and no
// status on any route: a facility refusal (security.authorization), a refusal
// before a facility is bound (auth.authorization.denied) and an
// unauthenticated request (security.authorization.denied) carried only the
// method and route, so an audit reader could not tell a missing permission
// from maintenance mode or an expired session. Every guard row now records the
// status and code the client is answered (problemStatusAndCode of the
// refusal); the outcome stays `denied`.

const ORIGIN = 'http://localhost:5173';
const facilityA = '10000000-0000-4000-8000-00000000000a';
const inactiveFacility = '10000000-0000-4000-8000-00000000000f';

const membership: FacilityAssignment = {
  id: facilityA, membershipId: '40000000-0000-4000-8000-00000000000a',
  organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A',
  roles: ['doctor'], permissions: ['patient.read'], isPrimary: true,
};

const staff: ActorContext = {
  kind: 'staff', id: 'staff:provider', subject: 'staff:provider', accountId: '20000000-0000-4000-8000-000000000002',
  sessionId: '90000000-0000-4000-8000-0000000000a2', roles: ['doctor'], permissions: ['patient.read'],
  platformRoles: [], platformPermissions: [], facilityIds: [facilityA], facilities: [membership], authenticationMethod: 'local',
};
const patient: ActorContext = {
  ...staff, kind: 'patient', id: 'patient:p', subject: 'patient:p', patientId: '50000000-0000-4000-8000-000000000001',
  facilityIds: [], facilities: [], roles: [], permissions: [],
};

interface RouteMetadata {
  platform?: boolean; facilityOptional?: boolean; patientAllowed?: boolean; patientOnly?: boolean;
  permissions?: readonly string[]; highRiskAction?: string;
}

function reflector(route: RouteMetadata): Reflector {
  return { getAllAndOverride: (key: symbol) => {
    if (key === PLATFORM_SCOPE) return route.platform;
    if (key === FACILITY_OPTIONAL) return route.facilityOptional;
    if (key === PATIENT_ALLOWED) return route.patientAllowed;
    if (key === PATIENT_ONLY) return route.patientOnly;
    if (key === REQUIRED_PERMISSIONS) return route.permissions;
    if (key === HIGH_RISK_ACTION) return route.highRiskAction;
    return undefined;
  } } as unknown as Reflector;
}

function httpRequest(headers: Record<string, string>, options: { method?: string; body?: unknown; path?: string;
  cookies?: Record<string, string> } = {}): HidRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { method: options.method ?? 'GET', correlationId: 'guard-refusal-audit-test', ip: '127.0.0.1',
    route: { path: options.path ?? '/identity/test' }, body: options.body, query: {}, cookies: options.cookies,
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function executionContext(request: HidRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
}

/**
 * The guard over a database that answers the runtime controls from `changed`
 * (all open otherwise) and the platform assurance as configured, and a token
 * service whose verify answers `verified` (an actor, or the error it throws).
 */
function guardFor(route: RouteMetadata, verified: ActorContext | Error, options: {
  changed?: Record<string, boolean>; assurance?: AssuranceOptions; mfaAssured?: boolean } = {}) {
  const controls: Record<string, boolean> = {
    maintenance_mode: false, provider_portal_enabled: true, patient_portal_enabled: true, ...options.changed };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const database = { query: jest.fn(async (sql: string, values: unknown[]) => {
    if (isAssuranceQuery(sql)) return assuranceResult(options.assurance);
    if (sql.includes('platform.control_enabled')) return { rowCount: 1, rows: [{ enabled: controls[values[0] as string] }] };
    throw new Error(`unexpected query: ${sql}`);
  }) };
  const tokens = {
    verify: verified instanceof Error ? jest.fn().mockRejectedValue(verified)
      : jest.fn().mockResolvedValue({ actor: verified, claims: {}, mfaAssured: options.mfaAssured ?? true }),
    verifyCsrf: jest.fn(() => true),
  };
  const guard = new SecurityGuard(reflector(route), tokens as unknown as TokenService,
    audit as unknown as AuditService, database as unknown as DatabaseService);
  return { guard, audit };
}

/** The guard's answer and the one row it recorded. */
async function refused(guard: SecurityGuard, audit: { record: jest.Mock }, request: HidRequest) {
  const error = await guard.canActivate(executionContext(request)).then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(HttpException);
  const problem = error as HttpException & { code?: string };
  expect(audit.record).toHaveBeenCalledTimes(1);
  return { answer: { status: problem.getStatus(), code: problem.code }, row: audit.record.mock.calls[0][0] as Record<string, unknown> };
}

const bearer = { authorization: 'Bearer signed' };
const atFacility = { ...bearer, 'x-facility-id': facilityA };

useTestEnvironment({ STORAGE_MODE: 'disabled', CORS_ORIGINS: ORIGIN, AUTH_COOKIE_NAME: 'hid_access' });

describe('SecurityGuard refusal rows record the answered status and code (A17)', () => {
  it('records a missing permission at the bound facility as security.authorization with 403 PERMISSION_DENIED', async () => {
    const { guard, audit } = guardFor({ permissions: ['identity.consent.write'] }, staff);
    const { answer, row } = await refused(guard, audit, httpRequest(atFacility));
    expect(answer).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    expect(row).toMatchObject({ action: 'security.authorization', facilityId: facilityA, outcome: 'denied' });
    expect(row.details).toEqual({ method: 'GET', route: '/identity/test', status: 403, code: 'PERMISSION_DENIED' });
  });

  it.each([
    ['a facility the actor is not active at', { permissions: ['patient.read'] }, staff,
      httpRequest({ ...bearer, 'x-facility-id': inactiveFacility }), {}, 'staff', { status: 403, code: 'FACILITY_ACCESS_DENIED' }],
    ['no X-Facility-ID', { permissions: ['patient.read'] }, staff, httpRequest(bearer), {}, 'staff',
      { status: 400, code: 'FACILITY_REQUIRED' }],
    ['a patient on a workforce route', { permissions: ['patient.read'] }, patient, httpRequest(atFacility), {}, 'patient',
      { status: 403, code: 'PATIENT_SCOPE_DENIED' }],
    ['a staff session on a patient-only route', { patientAllowed: true, patientOnly: true, facilityOptional: true }, staff,
      httpRequest(atFacility), {}, 'staff', { status: 403, code: 'PATIENT_SESSION_REQUIRED' }],
    ['a cookie write from a foreign Origin', { permissions: ['patient.read'] }, staff,
      httpRequest({ origin: 'https://elsewhere.example', 'x-facility-id': facilityA }, { method: 'POST',
        cookies: { hid_access: 'signed', hid_access_csrf: 'csrf' } }), {}, 'staff', { status: 403, code: 'ORIGIN_DENIED' }],
    ['maintenance mode', { permissions: ['patient.read'] }, staff, httpRequest(atFacility), { maintenance_mode: true }, 'staff',
      { status: 503, code: 'PLATFORM_MAINTENANCE' }],
    ['the provider portal disabled', { permissions: ['patient.read'] }, staff, httpRequest(atFacility),
      { provider_portal_enabled: false }, 'staff', { status: 423, code: 'PLATFORM_PORTAL_DISABLED' }],
  ] as const)('records a refusal before a facility is bound (%s) with its status and code', async (
    _case, route, actor, request, changed, actorType, expected) => {
    const { guard, audit } = guardFor(route, actor, { changed });
    const { answer, row } = await refused(guard, audit, request);
    expect(answer).toEqual(expected);
    expect(row).toMatchObject({ actorType, action: 'auth.authorization.denied', resourceType: 'authentication',
      outcome: 'denied' });
    expect(row.facilityId).toBeUndefined();
    expect(row.details).toEqual({ method: request.method, route: '/identity/test', ...expected });
  });

  it('records a staff session without MFA assurance (0088) with 403 STAFF_MFA_REQUIRED', async () => {
    const { guard, audit } = guardFor({ permissions: ['patient.read'] }, staff, { mfaAssured: false });
    const { answer, row } = await refused(guard, audit, httpRequest(atFacility));
    expect(answer).toEqual({ status: 403, code: 'STAFF_MFA_REQUIRED' });
    expect(row).toMatchObject({ actorType: 'staff', action: 'auth.authorization.denied', resourceType: 'authentication',
      outcome: 'denied' });
    expect(row.facilityId).toBeUndefined();
    expect(row.details).toEqual({ method: 'GET', route: '/identity/test', status: 403, code: 'STAFF_MFA_REQUIRED' });
  });

  it.each([
    ['no credential', undefined],
    ['an invalid or expired access token', new UnauthorizedException('Invalid or expired access token')],
  ])('records %s as a system refusal with 401 AUTHENTICATION_REQUIRED and no message', async (_case, failure) => {
    const { guard, audit } = guardFor({ permissions: ['patient.read'] }, failure ?? staff);
    const request = httpRequest(failure ? atFacility : { 'x-facility-id': facilityA });
    const { answer, row } = await refused(guard, audit, request);
    expect(answer).toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(row).toMatchObject({ actorType: 'system', action: 'security.authorization.denied', outcome: 'denied' });
    expect(row.details).toEqual({ method: 'GET', route: '/identity/test', status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(JSON.stringify(row)).not.toContain('Invalid or expired');
  });

  it('records a fault while checking the credential with the 503 it is answered (A4), still as denied', async () => {
    const { guard, audit } = guardFor({ permissions: ['patient.read'] }, new Error('Connection terminated unexpectedly'));
    const { answer, row } = await refused(guard, audit, httpRequest(atFacility));
    expect(answer).toEqual({ status: 503, code: 'AUTHENTICATION_UNAVAILABLE' });
    expect(row).toMatchObject({ actorType: 'system', outcome: 'denied' });
    expect(row.details).toEqual({ method: 'GET', route: '/identity/test', status: 503, code: 'AUTHENTICATION_UNAVAILABLE' });
    expect(JSON.stringify(row)).not.toContain('Connection terminated');
  });
});

describe('SecurityGuard platform refusal rows record the answered status with the code (A17)', () => {
  const adminRoute = { path: '/admin/test' };

  it('records a platform session missing a permission with 403 PERMISSION_DENIED', async () => {
    const { guard, audit } = guardFor({ platform: true, permissions: ['platform.audit.read'] },
      platformActor({ platformPermissions: ['platform.admin.access'] }));
    const { answer, row } = await refused(guard, audit, httpRequest(bearer, adminRoute));
    expect(answer).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    expect(row).toMatchObject({ action: 'security.authorization', accessScope: 'platform', outcome: 'denied' });
    expect(row.details).toEqual({ method: 'GET', route: '/admin/test', status: 403, code: 'PERMISSION_DENIED' });
  });

  it('records a critical command without a fresh step-up with 403 STEP_UP_REQUIRED and its action', async () => {
    const { guard, audit } = guardFor({ platform: true, permissions: ['platform.role.manage'],
      highRiskAction: 'platform.role.change' }, platformActor(), { assurance: { stepUpFresh: false } });
    const request = httpRequest({ ...bearer, 'if-match': '"3"', 'idempotency-key': 'role-change-0000000001' },
      { ...adminRoute, method: 'POST', body: { reason: 'Quarterly access review' } });
    const { answer, row } = await refused(guard, audit, request);
    expect(answer).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(row.details).toEqual({ method: 'POST', route: '/admin/test', status: 403, code: 'STEP_UP_REQUIRED',
      highRiskAction: 'platform.role.change' });
  });

  it('records a workforce attach (0087) without a fresh step-up with 403 STEP_UP_REQUIRED and its action', async () => {
    const { guard, audit } = guardFor({ platform: true, permissions: ['platform.workforce.manage'],
      highRiskAction: 'platform.workforce.attach' },
    platformActor({ platformPermissions: ['platform.admin.access', 'platform.workforce.manage'] }),
    { assurance: { stepUpFresh: false } });
    const request = httpRequest({ ...bearer, 'idempotency-key': 'workforce-attach-0000000001' },
      { path: '/admin/workforce/memberships', method: 'POST', body: { reason: 'New clinician at Facility A' } });
    const { answer, row } = await refused(guard, audit, request);
    expect(answer).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(row).toMatchObject({ action: 'security.authorization', accessScope: 'platform', outcome: 'denied' });
    expect(row.details).toEqual({ method: 'POST', route: '/admin/workforce/memberships', status: 403,
      code: 'STEP_UP_REQUIRED', highRiskAction: 'platform.workforce.attach' });
  });

  it('records a staff token on a platform route with 403 PLATFORM_SESSION_REQUIRED', async () => {
    const { guard, audit } = guardFor({ platform: true, permissions: ['platform.audit.read'] }, staff);
    const { answer, row } = await refused(guard, audit, httpRequest(bearer, adminRoute));
    expect(answer).toEqual({ status: 403, code: 'PLATFORM_SESSION_REQUIRED' });
    expect(row.details).toEqual({ method: 'GET', route: '/admin/test', status: 403, code: 'PLATFORM_SESSION_REQUIRED' });
  });
});
