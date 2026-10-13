jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Controller, Get, Post, ServiceUnavailableException, UnauthorizedException,
  type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditService } from '../audit/audit.service';
import { EmergencyContactController } from '../patient-safety/emergency-contact.controller';
import { PatientAccountDeletionController } from '../patient-safety/patient-account-deletion.controller';
import { ConsentController } from '../consent/consent.controller';
import { QoreIdVerificationController } from '../identity/qoreid-verification.controller';
import { FacilityOptional, HighRiskAction, PatientAllowed, PlatformScope, RequirePermissions } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { assuranceResult, isAssuranceQuery, platformActor } from '../testing/platform-assurance';
import { AuthController } from './auth.controller';
import { PatientSelfController } from './patient-self.controller';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';

// A4: the guard had one catch for refusals and faults, and rewrote every
// error that was not a DomainProblem (a pg error from the runtime controls,
// from session verification, actor resolution or the platform assurance read)
// into the 401 a client reads as "your session ended". A partial database
// fault therefore signed every patient and provider out of Health-id.
// A16: a staff (clinical) session of an account that also holds a platform
// grant skipped maintenance mode and the portal switches.
// A9: patient-only routes refused a staff session in the handler, where the
// refusal's audit row was refused (no facility) and the answer became 503.

const facility: FacilityAssignment = {
  id: '10000000-0000-4000-8000-00000000000a', membershipId: '40000000-0000-4000-8000-00000000000a',
  organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A', roles: ['doctor'],
  permissions: ['identity.patient.read'], isPrimary: true,
};

const staff: ActorContext = {
  kind: 'staff', id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
  sessionId: '90000000-0000-4000-8000-000000000001', roles: ['doctor'], permissions: ['identity.patient.read'],
  platformRoles: [], platformPermissions: [], facilityIds: [facility.id], facilities: [facility], facility,
  authenticationMethod: 'local',
} as ActorContext;

/** The staff (clinical) session of an account that also holds a platform administration grant. */
const staffWithPlatformGrant: ActorContext = { ...staff, platformRoles: ['platform_super_admin'],
  platformPermissions: ['platform.admin.access', 'platform.control.manage'] };

const patient: ActorContext = {
  kind: 'patient', id: 'patient:ada', subject: 'patient:ada', accountId: '20000000-0000-4000-8000-0000000000c1',
  patientId: '50000000-0000-4000-8000-000000000001', sessionId: '90000000-0000-4000-8000-0000000000c1',
  roles: [], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [],
  authenticationMethod: 'local',
} as ActorContext;

@Controller('probe')
class ProbeController {
  @Get('facility')
  @RequirePermissions('identity.patient.read')
  facilityRoute() { return {}; }

  @Get('optional')
  @FacilityOptional()
  @PatientAllowed()
  optionalRoute() { return {}; }

  @Post('controls')
  @PlatformScope()
  @RequirePermissions('platform.control.manage')
  @HighRiskAction('platform.control.change')
  setControl() { return {}; }
}

function httpRequest(headers: Record<string, string>, options: { method?: string; body?: unknown } = {}): HidRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { method: options.method ?? 'GET', correlationId: 'security-guard-test', ip: '127.0.0.1',
    route: { path: '/probe' }, body: options.body, query: {}, cookies: {},
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function context(request: HidRequest, handler: (...args: never[]) => unknown, owner: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => handler, getClass: () => owner } as unknown as ExecutionContext;
}

interface Setup {
  actor?: ActorContext;
  verify?: () => Promise<unknown>;
  controls?: Record<string, boolean>;
  controlFault?: unknown;
  assuranceFault?: unknown;
  auditFault?: unknown;
}

function guardFor(setup: Setup = {}) {
  const controls = { maintenance_mode: false, patient_portal_enabled: true, provider_portal_enabled: true,
    ...setup.controls };
  const audit = { record: jest.fn(async () => { if (setup.auditFault) throw setup.auditFault; }) };
  const database = { query: jest.fn(async (sql: string, parameters: unknown[]) => {
    if (isAssuranceQuery(sql)) {
      if (setup.assuranceFault) throw setup.assuranceFault;
      return assuranceResult({ stepUpFresh: true });
    }
    if (sql.includes('platform.control_enabled')) {
      if (setup.controlFault) throw setup.controlFault;
      return { rows: [{ enabled: controls[parameters[0] as keyof typeof controls] === true }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }) };
  const tokens = {
    verify: jest.fn(setup.verify ?? (async () => ({ actor: setup.actor ?? staff, claims: {}, mfaAssured: true }))),
    verifyCsrf: jest.fn(() => true),
  };
  const guard = new SecurityGuard(new Reflector(), tokens as unknown as TokenService,
    audit as unknown as AuditService, database as unknown as DatabaseService);
  return { guard, audit, database, tokens };
}

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

const pgError = (code: string, message = `synthetic ${code}`) => Object.assign(new Error(message), { code });
const sessionRead = () => httpRequest({ authorization: 'Bearer signed' });
const sessionRoute = AuthController.prototype.session;

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local', STORAGE_MODE: 'disabled',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});
afterEach(() => resetEnvironmentForTests());

describe('SecurityGuard: a dependency fault is 503, never a sign-out 401 (A4)', () => {
  it.each([
    ['a statement timeout (57014)', pgError('57014')],
    ['a pool timeout with no SQLSTATE', new Error('timeout exceeded when trying to connect')],
    ['a missing EXECUTE grant (42501)', pgError('42501')],
  ])('answers a runtime-control fault from %s with 503 PLATFORM_CONTROL_UNAVAILABLE and one denied audit row',
    async (_label, fault) => {
      const { guard, audit } = guardFor({ controlFault: fault });
      const problem = await refusal(guard.canActivate(context(sessionRead(), sessionRoute, AuthController)));
      expect([problem.getStatus(), problem.code]).toEqual([503, 'PLATFORM_CONTROL_UNAVAILABLE']);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
    });

  it('still answers a disabled control (55000 PLATFORM_CONTROL_DISABLED) as the control being off', async () => {
    const { guard } = guardFor({ controlFault: pgError('55000', 'PLATFORM_CONTROL_DISABLED: provider_portal_enabled') });
    const problem = await refusal(guard.canActivate(context(sessionRead(), sessionRoute, AuthController)));
    expect([problem.getStatus(), problem.code]).toEqual([423, 'PLATFORM_PORTAL_DISABLED']);
  });

  it('answers a database fault during session verification (08006) with 503 AUTHENTICATION_UNAVAILABLE', async () => {
    const { guard, audit } = guardFor({ verify: async () => { throw pgError('08006', 'connection failure'); } });
    const problem = await refusal(guard.canActivate(context(sessionRead(), sessionRoute, AuthController)));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'AUTHENTICATION_UNAVAILABLE']);
    expect(problem.message).toBe('Authentication is temporarily unavailable');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('keeps a genuine authentication failure 401 AUTHENTICATION_REQUIRED with the generic detail', async () => {
    const { guard } = guardFor({ verify: async () => { throw new UnauthorizedException('Session is no longer active'); } });
    const problem = await refusal(guard.canActivate(context(sessionRead(), sessionRoute, AuthController)));
    expect([problem.getStatus(), problem.code, problem.message])
      .toEqual([401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required']);
  });

  it('answers a fault reading the platform assurance of a step-up route with 503, not 401', async () => {
    const { guard } = guardFor({ actor: platformActor(), assuranceFault: pgError('57014') });
    const request = httpRequest({ authorization: 'Bearer signed', 'if-match': '"3"' },
      { method: 'POST', body: { reason: 'Planned maintenance window' } });
    const problem = await refusal(guard.canActivate(context(request, ProbeController.prototype.setControl,
      ProbeController)));
    expect(problem.getStatus()).toBe(503);
    expect(problem.code).toBe('AUTHENTICATION_UNAVAILABLE');
  });

  it('answers 503 when the denial audit cannot be written either', async () => {
    const { guard } = guardFor({ controlFault: pgError('57014'),
      auditFault: new ServiceUnavailableException('Audit persistence is unavailable; request was denied') });
    const error = await guard.canActivate(context(sessionRead(), sessionRoute, AuthController))
      .then(() => undefined, (failure: unknown) => failure);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it('keeps maintenance mode 503 PLATFORM_MAINTENANCE', async () => {
    const { guard } = guardFor({ controls: { maintenance_mode: true } });
    const problem = await refusal(guard.canActivate(context(sessionRead(), sessionRoute, AuthController)));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'PLATFORM_MAINTENANCE']);
  });
});

describe('SecurityGuard: a platform grant does not exempt a clinical session from runtime controls (A16)', () => {
  it('refuses the staff session of a platform administrator in maintenance mode', async () => {
    const { guard } = guardFor({ actor: staffWithPlatformGrant, controls: { maintenance_mode: true } });
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facility.id });
    const problem = await refusal(guard.canActivate(context(request, ProbeController.prototype.facilityRoute,
      ProbeController)));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'PLATFORM_MAINTENANCE']);
  });

  it('refuses the staff session of a platform administrator while the provider portal is disabled', async () => {
    const { guard } = guardFor({ actor: staffWithPlatformGrant, controls: { provider_portal_enabled: false } });
    const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facility.id });
    const problem = await refusal(guard.canActivate(context(request, ProbeController.prototype.facilityRoute,
      ProbeController)));
    expect([problem.getStatus(), problem.code]).toEqual([423, 'PLATFORM_PORTAL_DISABLED']);
  });

  it('still lets a platform session reach the console during maintenance, POST /admin/controls included', async () => {
    const { guard } = guardFor({ actor: platformActor(), controls: { maintenance_mode: true,
      provider_portal_enabled: false, patient_portal_enabled: false } });
    const request = httpRequest({ authorization: 'Bearer signed', 'if-match': '"3"' },
      { method: 'POST', body: { reason: 'Planned maintenance window' } });
    await expect(guard.canActivate(context(request, ProbeController.prototype.setControl, ProbeController)))
      .resolves.toBe(true);
  });
});

describe('SecurityGuard: patient-only routes refuse any other session as 403 PATIENT_SESSION_REQUIRED (A9)', () => {
  const patientOnlyRoutes: [string, (...args: never[]) => unknown, object][] = [
    ['GET /identity/me', PatientSelfController.prototype.profile, PatientSelfController],
    ['GET /identity/me/access-history', PatientSelfController.prototype.history, PatientSelfController],
    ['GET /identity/me/notifications', PatientSelfController.prototype.notificationInbox, PatientSelfController],
    ['POST /identity/me/access-pin', PatientSelfController.prototype.setAccessPin, PatientSelfController],
    ['GET /identity/me/access-requests', ConsentController.prototype.listMyAccessRequests, ConsentController],
    ['POST /identity/access-requests/:id/approve', ConsentController.prototype.approveAccessRequest, ConsentController],
    ['POST /identity/access-requests/:id/deny', ConsentController.prototype.denyAccessRequest, ConsentController],
    ['POST /identity/me/consent-grants/:id/revoke', ConsentController.prototype.revokeMyConsentGrant, ConsentController],
    ['GET /identity/me/emergency-contacts', EmergencyContactController.prototype.list, EmergencyContactController],
    ['GET /identity/me/account-deletion', PatientAccountDeletionController.prototype.status,
      PatientAccountDeletionController],
    ['POST /identity/me/verification/nin', QoreIdVerificationController.prototype.verifyMyNin,
      QoreIdVerificationController],
  ];

  it.each(patientOnlyRoutes)('%s: a staff session is refused before the handler, audited without a facility',
    async (_label, handler, owner) => {
      const { guard, audit } = guardFor({ actor: staff });
      const problem = await refusal(guard.canActivate(context(httpRequest({ authorization: 'Bearer signed' }),
        handler, owner)));
      expect([problem.getStatus(), problem.code]).toEqual([403, 'PATIENT_SESSION_REQUIRED']);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'staff',
        action: 'auth.authorization.denied', resourceType: 'authentication', outcome: 'denied' }));
      const row = audit.record.mock.calls[0] as unknown as [{ facilityId?: string; actorMembershipId?: string }];
      expect(row[0].facilityId).toBeUndefined();
      expect(row[0].actorMembershipId).toBeUndefined();
    });

  it('admits a patient session on a patient-only route', async () => {
    const { guard } = guardFor({ actor: patient });
    await expect(guard.canActivate(context(httpRequest({ authorization: 'Bearer signed' }),
      PatientSelfController.prototype.profile, PatientSelfController))).resolves.toBe(true);
  });

  it('keeps GET /auth/session open to a staff session (it is not patient-only)', async () => {
    const { guard } = guardFor({ actor: staff });
    await expect(guard.canActivate(context(sessionRead(), sessionRoute, AuthController))).resolves.toBe(true);
  });

  it('keeps a facility-optional route that is not patient-only open to a staff session', async () => {
    const { guard } = guardFor({ actor: staff });
    await expect(guard.canActivate(context(sessionRead(), ProbeController.prototype.optionalRoute,
      ProbeController))).resolves.toBe(true);
  });
});
