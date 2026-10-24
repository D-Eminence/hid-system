jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { EmergencyContactController } from '../patient-safety/emergency-contact.controller';
import { PatientSelfController } from './patient-self.controller';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';

// A9: a patient-only route refused a staff session in the handler, where the
// refusal's audit row was refused (a staff api.* row with no facility) and the
// answer became 503 with nothing recorded.

const facility: FacilityAssignment = {
  id: '10000000-0000-4000-8000-00000000000a', membershipId: '40000000-0000-4000-8000-00000000000a',
  organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A', roles: ['doctor'],
  permissions: ['identity.patient.read'], isPrimary: true,
};

const staff: ActorContext = {
  kind: 'staff', id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
  sessionId: '90000000-0000-4000-8000-000000000001', roles: ['doctor'], permissions: ['identity.patient.read'],
  platformRoles: [], platformPermissions: [], facilityIds: [facility.id], facilities: [facility],
  authenticationMethod: 'local',
};

const platformAdmin: ActorContext = { ...staff, id: 'staff:admin', subject: 'staff:admin', facilityIds: [], facilities: [],
  roles: [], permissions: [], platformRoles: ['support_admin'],
  platformPermissions: ['platform.admin.access', 'platform.emergency-contact.manage'] };

const patient: ActorContext = {
  kind: 'patient', id: 'patient:ada', subject: 'patient:ada', accountId: '20000000-0000-4000-8000-0000000000c1',
  patientId: '50000000-0000-4000-8000-000000000001', sessionId: '90000000-0000-4000-8000-0000000000c1',
  roles: [], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [],
  authenticationMethod: 'local',
};

function httpRequest(headers: Record<string, string>, method = 'GET'): HidRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { method, correlationId: 'security-guard-test', ip: '127.0.0.1',
    route: { path: '/identity/me/emergency-contacts' }, query: {}, cookies: {},
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function context(request: HidRequest, handler: (...args: never[]) => unknown, owner: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => handler, getClass: () => owner } as unknown as ExecutionContext;
}

function guardFor(actor: ActorContext) {
  const audit = { record: jest.fn(async () => undefined) };
  // Both portals on and maintenance mode off.
  const database = { query: jest.fn(async (_sql: string, parameters: unknown[]) =>
    ({ rows: [{ enabled: parameters[0] !== 'maintenance_mode' }], rowCount: 1 })) };
  const tokens = { verify: jest.fn(async () => ({ actor, claims: {} })), verifyCsrf: jest.fn(() => true) };
  const guard = new SecurityGuard(new Reflector(), tokens as unknown as TokenService,
    audit as unknown as AuditService, database as unknown as DatabaseService);
  return { guard, audit };
}

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});
afterEach(() => resetEnvironmentForTests());

describe('SecurityGuard: patient-only routes refuse any other session as 403 PATIENT_SESSION_REQUIRED (A9)', () => {
  const emergencyContactRoutes: [string, (...args: never[]) => unknown][] = [
    ['GET /identity/me/emergency-contacts', EmergencyContactController.prototype.list],
    ['GET /identity/me/emergency-contacts/availability', EmergencyContactController.prototype.availability],
    ['POST /identity/me/emergency-contacts', EmergencyContactController.prototype.add],
    ['POST /identity/me/emergency-contacts/:id', EmergencyContactController.prototype.update],
    ['POST /identity/me/emergency-contacts/:id/deactivate', EmergencyContactController.prototype.deactivate],
    ['POST /identity/me/emergency-contacts/:id/verification', EmergencyContactController.prototype.sendVerification],
    ['POST /identity/me/emergency-contacts/:id/verification/confirm',
      EmergencyContactController.prototype.confirmVerification],
  ];

  it.each(emergencyContactRoutes)('%s: a staff session is refused before the handler, audited without a facility',
    async (label, handler) => {
      const { guard, audit } = guardFor(staff);
      // Even a staff session naming one of its own facilities is refused unbound.
      const request = httpRequest({ authorization: 'Bearer signed', 'x-facility-id': facility.id },
        label.startsWith('POST') ? 'POST' : 'GET');
      const problem = await refusal(guard.canActivate(context(request, handler, EmergencyContactController)));
      expect([problem.getStatus(), problem.code]).toEqual([403, 'PATIENT_SESSION_REQUIRED']);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'staff',
        action: 'auth.authorization.denied', resourceType: 'authentication', outcome: 'denied' }));
      const row = audit.record.mock.calls[0] as unknown as [{ facilityId?: string; actorMembershipId?: string }];
      expect(row[0].facilityId).toBeUndefined();
      expect(row[0].actorMembershipId).toBeUndefined();
      expect(request.facilityId).toBeUndefined();
    });

  it('refuses a platform administrator session too', async () => {
    const { guard } = guardFor(platformAdmin);
    const problem = await refusal(guard.canActivate(context(httpRequest({ authorization: 'Bearer signed' }),
      EmergencyContactController.prototype.list, EmergencyContactController)));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'PATIENT_SESSION_REQUIRED']);
  });

  it('admits a patient session on a patient-only route', async () => {
    const { guard, audit } = guardFor(patient);
    await expect(guard.canActivate(context(httpRequest({ authorization: 'Bearer signed' }),
      EmergencyContactController.prototype.list, EmergencyContactController))).resolves.toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('leaves a patient-allowed route that is not patient-only unchanged for a staff session', async () => {
    const { guard } = guardFor(staff);
    await expect(guard.canActivate(context(httpRequest({ authorization: 'Bearer signed' }),
      PatientSelfController.prototype.profile, PatientSelfController))).resolves.toBe(true);
  });
});
