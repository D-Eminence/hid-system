jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Controller, Get, type INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { CorrelationMiddleware } from '../common/correlation.middleware';
import { FacilityOptional, PatientAllowed } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { ConsentController } from '../consent/consent.controller';
import { ConsentService } from '../consent/consent.service';
import type { DatabaseService } from '../database/database.service';
import { QoreIdVerificationController } from '../identity/qoreid-verification.controller';
import { QoreIdVerificationService } from '../identity/qoreid-verification.service';
import { EmergencyContactController } from '../patient-safety/emergency-contact.controller';
import { EmergencyContactService } from '../patient-safety/emergency-contact.service';
import { PatientAccountDeletionController } from '../patient-safety/patient-account-deletion.controller';
import { PatientAccountDeletionService } from '../patient-safety/patient-account-deletion.service';
import { platformActor } from '../testing/platform-assurance';
import { PatientSelfController } from './patient-self.controller';
import { PatientSelfService, requirePatient } from './patient-self.service';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';
import { WorkloadAuthService } from './workload-auth.service';

// A9, on every patient-only route: a staff sign-in there answered 503
// DEPENDENCY_UNAVAILABLE and recorded nothing. The routes admitted a staff
// session with no facility bound, the handler refused it (requirePatient, 403
// PATIENT_SESSION_REQUIRED), and the AuditInterceptor recorded the refusal as
// an `api.*` request of a staff actor without a facility, which
// AuditService.assertActorFacility and the 0067 CHECKs accept only as an
// `auth.*` event, so the audit write failed closed. @PatientOnly() now has
// SecurityGuard refuse any other session first. These tests run the real
// SecurityGuard, interceptor, audit service, validation pipe and problem
// filter, as AppModule and main.ts register them, with the real controllers
// over service stubs that refuse a non-patient exactly as every real service
// method does first, so a route that loses @PatientOnly() fails here.

const ORIGIN = 'https://www.healthidentitydirectory.com';
const ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const DEFAULT_FACILITY = { id: '30000000-0000-4000-8000-000000000001', membershipId: '40000000-0000-4000-8000-000000000001',
  organizationId: '50000000-0000-4000-8000-000000000001', name: 'Lagos General', roles: ['clinician'], permissions: [], isPrimary: true };

/** A staff actor as CurrentStaffContextService builds it: no `kind`, its default facility attached. */
const staff = { id: 'staff:s', subject: 'staff:s', accountId: '20000000-0000-4000-8000-0000000000b1',
  sessionId: '90000000-0000-4000-8000-0000000000b1', roles: ['clinician'], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: [DEFAULT_FACILITY.id], facilities: [DEFAULT_FACILITY], facility: DEFAULT_FACILITY,
  authenticationMethod: 'local' } as unknown as ActorContext;
const patient = { id: 'patient:p', subject: 'patient:p', kind: 'patient', patientId: '60000000-0000-4000-8000-000000000001',
  accountId: '20000000-0000-4000-8000-0000000000c1', sessionId: '90000000-0000-4000-8000-0000000000c1', roles: [],
  permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [],
  authenticationMethod: 'local' } as unknown as ActorContext;

/** The audit row as AuditService writes it, by column. */
interface Row { actorType: string; actorSubject: string | null; actorAccountId: string | null; actorMembershipId: string | null;
  organizationId: string | null; facilityId: string | null; patientId: string | null; action: string; resourceType: string | null;
  outcome: string; purposeOfUse: string | null; details: Record<string, unknown>; accessScope: string | null }

/**
 * A database that answers the guard's runtime controls (maintenance off, both
 * portals on), keeps the audit rows written and, like audit.events, refuses a
 * row that 0067's events_staff_facility_scope_check,
 * events_staff_membership_scope_check or events_platform_scope_shape_check
 * refuses.
 */
function auditDatabase(rows: Row[], faults: { audit?: unknown }) {
  const controls: Record<string, boolean> = { maintenance_mode: false, provider_portal_enabled: true, patient_portal_enabled: true };
  return {
    query: jest.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: controls[values[0] as string] }], rowCount: 1 };
      if (!sql.includes('insert into audit.events')) throw new Error(`unexpected query: ${sql}`);
      if (faults.audit) throw faults.audit;
      const row = { actorType: values[1], actorSubject: values[2], actorAccountId: values[3], actorMembershipId: values[4],
        organizationId: values[5], facilityId: values[6], patientId: values[7], action: values[8], resourceType: values[9],
        outcome: values[11], purposeOfUse: values[12], details: JSON.parse(values[16] as string),
        accessScope: values[19] } as Row;
      const platform = row.accessScope === 'platform';
      const facilityScope = row.facilityId !== null || row.actorType !== 'staff' || platform
        || (row.action.startsWith('auth.') && ['authentication', 'session'].includes(row.resourceType ?? ''));
      const membershipScope = row.actorType !== 'staff' || row.action.startsWith('auth.') || platform
        || (row.actorAccountId !== null && row.actorMembershipId !== null && row.facilityId !== null);
      const platformShape = !platform || (row.actorType === 'staff' && row.actorSubject !== null
        && row.actorAccountId !== null && row.actorMembershipId === null && row.facilityId === null);
      if (!facilityScope || !membershipScope || !platformShape) {
        throw Object.assign(new Error('audit.events check violation'), { code: '23514' });
      }
      rows.push(row);
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as DatabaseService;
}

/** A service whose methods each refuse a non-patient first, as every real one does, then answer. */
function patientService(...methods: string[]): Record<string, jest.Mock> {
  return Object.fromEntries(methods.map((method) => [method, jest.fn((served: HidRequest) => {
    requirePatient(served.actor);
    return { ok: true };
  })]));
}

/** A handler refusal and a handler fault on a facility-optional patient route that is not patient-only. */
@Controller('probe')
@PatientAllowed()
@FacilityOptional()
class ProbeController {
  @Get('refused')
  refused() { throw new DomainProblem(403, 'PROBE_REFUSED', 'Refused by the handler'); }

  @Get('fault')
  fault() { throw new Error('handler fault with internal detail'); }
}

const EHR_WORKLOAD = { 'X-HID-Internal-Caller': 'ehr-api', 'X-HID-Service-Token': 'workload-token' };

/** Every patient-only route, with a body its DTO accepts. */
interface PatientRoute { method: 'get' | 'post' | 'delete'; path: string; body?: object; headers?: Record<string, string> }
const PATIENT_ONLY_ROUTES: readonly PatientRoute[] = [
  { method: 'get', path: 'identity/me' },
  { method: 'get', path: 'identity/me/access-history' },
  { method: 'get', path: 'identity/me/notifications' },
  { method: 'post', path: `identity/me/notifications/${ID}/read` },
  { method: 'post', path: 'identity/me/access-pin', body: { pin: '2580' } },
  { method: 'delete', path: 'identity/me/access-pin' },
  { method: 'get', path: 'identity/service/patient-self-authorization', headers: EHR_WORKLOAD },
  { method: 'get', path: 'identity/me/access-requests' },
  { method: 'post', path: `identity/access-requests/${ID}/approve` },
  { method: 'post', path: `identity/access-requests/${ID}/deny`, body: { reason: 'Not my clinic' } },
  { method: 'post', path: `identity/me/consent-grants/${ID}/revoke`, body: { reason: 'No longer needed' } },
  { method: 'get', path: 'identity/me/emergency-contacts' },
  { method: 'post', path: 'identity/me/emergency-contacts', body: { name: 'Ada Obi', relationship: 'sibling',
    channel: 'email', destination: 'ada@example.invalid' } },
  { method: 'post', path: `identity/me/emergency-contacts/${ID}`, body: { expectedVersion: 1, name: 'Ada Obi' } },
  { method: 'post', path: `identity/me/emergency-contacts/${ID}/deactivate` },
  { method: 'post', path: `identity/me/emergency-contacts/${ID}/verification` },
  { method: 'post', path: `identity/me/emergency-contacts/${ID}/verification/confirm`,
    body: { challengeId: ID, code: '123456' } },
  { method: 'get', path: 'identity/me/account-deletion' },
  { method: 'post', path: 'identity/me/account-deletion' },
  { method: 'post', path: 'identity/me/account-deletion/confirm',
    body: { requestId: ID, confirmationToken: 'A'.repeat(43), confirmation: 'DELETE' } },
  { method: 'post', path: 'identity/me/account-deletion/cancel', body: { requestId: ID } },
  { method: 'post', path: 'identity/me/verification/nin', body: { nin: '12345678901' } },
];

let app: INestApplication;
let rows: Row[];
let faults: { audit?: unknown };
let liveActor: ActorContext;
/** Whether the live session's sign-in has MFA assurance (0088); every staff session needs it. */
let mfaAssured: boolean;
let services: Record<string, Record<string, jest.Mock>>;
let workloads: { authenticateService: jest.Mock };

beforeEach(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: ORIGIN, AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'false',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', TURNSTILE_MODE: 'disabled' });
  resetEnvironmentForTests();
  rows = [];
  faults = {};
  liveActor = staff;
  mfaAssured = true;
  const database = auditDatabase(rows, faults);
  const tokens = {
    // "access-live" is a live access token for `liveActor`, with CSRF token "csrf-live".
    verify: jest.fn(async (token: string) => {
      if (token !== 'access-live') throw new UnauthorizedException('Invalid or expired access token');
      return { actor: liveActor, claims: { csrf_hash: 'hash-of-csrf-live' }, mfaAssured };
    }),
    verifyCsrf: jest.fn((claims: { csrf_hash: string }, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && claims.csrf_hash === `hash-of-${cookie}`),
  };
  workloads = { authenticateService: jest.fn().mockResolvedValue({ caller: 'ehr-api' }) };
  services = {
    self: patientService('profile', 'history', 'notificationInbox', 'markNotificationRead', 'setAccessPin',
      'revokeAccessPin', 'authorize'),
    consent: patientService('listMyAccessRequests', 'approveAccessRequest', 'denyAccessRequest', 'revokeMyConsentGrant'),
    contacts: patientService('list', 'add', 'update', 'deactivate', 'sendVerification', 'confirmVerification'),
    deletion: patientService('status', 'request', 'confirm', 'cancel'),
    verification: patientService('verifyPatientNin'),
  };
  const module = await Test.createTestingModule({
    controllers: [PatientSelfController, ConsentController, EmergencyContactController, PatientAccountDeletionController,
      QoreIdVerificationController, ProbeController],
    providers: [
      { provide: PatientSelfService, useValue: services.self },
      { provide: ConsentService, useValue: services.consent },
      { provide: EmergencyContactService, useValue: services.contacts },
      { provide: PatientAccountDeletionService, useValue: services.deletion },
      { provide: QoreIdVerificationService, useValue: services.verification },
      { provide: WorkloadAuthService, useValue: workloads },
      { provide: AuditService, useFactory: () => new AuditService(database) },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  const correlation = new CorrelationMiddleware();
  app.use((incoming: HidRequest, response: Response, next: NextFunction) => correlation.use(incoming, response, next));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  const reflector = module.get(Reflector);
  app.useGlobalGuards(new SecurityGuard(reflector, tokens as unknown as TokenService, module.get(AuditService), database,
    workloads as unknown as WorkloadAuthService));
  app.useGlobalInterceptors(new AuditInterceptor(reflector, module.get(AuditService)));
  await app.init();
});

afterEach(async () => { await app.close(); });

/** A call with the live access cookie, and on a write the browser's Origin and the matching CSRF token. */
function withCookie(method: 'get' | 'post' | 'delete', path: string, headers: Record<string, string> = {}) {
  const call = request(app.getHttpServer())[method](`/api/v1/${path}`)
    .set('Cookie', 'hid_access=access-live; hid_access_csrf=csrf-live');
  if (method !== 'get') call.set('Origin', ORIGIN).set('X-CSRF-Token', 'csrf-live');
  return call.set(headers);
}

/** Every service method the handlers reached. */
const served = () => Object.entries(services).flatMap(([service, methods]) => Object.entries(methods)
  .filter(([, method]) => method.mock.calls.length > 0).map(([name]) => `${service}.${name}`));

/** SecurityGuard's refusal before a facility is bound: an auth event with no facility, membership or organization. */
const guardRefusal = (actor: ActorContext) => expect.objectContaining({ actorType: 'staff', actorSubject: actor.subject,
  actorAccountId: actor.accountId, action: 'auth.authorization.denied', resourceType: 'authentication', outcome: 'denied',
  facilityId: null, actorMembershipId: null, organizationId: null, patientId: null, accessScope: null });

describe('a staff session on a patient-only route (A9)', () => {
  it.each(PATIENT_ONLY_ROUTES)('$method /$path answers 403 PATIENT_SESSION_REQUIRED and records the guard\'s refusal',
    async ({ method, path, body, headers }) => {
      const call = withCookie(method, path, headers);
      const response = await (body ? call.send(body) : call);
      expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
      expect(rows).toEqual([guardRefusal(staff)]);
      expect(served()).toEqual([]);
      expect(workloads.authenticateService).not.toHaveBeenCalled();
    });

  it.each([
    ['get', 'identity/me', undefined],
    ['post', 'identity/me/emergency-contacts', { name: 'Ada Obi', relationship: 'sibling', channel: 'email',
      destination: 'ada@example.invalid' }],
  ] as const)('refuses a staff bearer token on %s /%s the same way', async (method, path, body) => {
    const call = request(app.getHttpServer())[method](`/api/v1/${path}`).set('Authorization', 'Bearer access-live');
    const response = await (body ? call.send(body) : call);
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(rows).toEqual([guardRefusal(staff)]);
    expect(served()).toEqual([]);
  });

  it('refuses it before validating the body', async () => {
    const response = await withCookie('post', 'identity/me/verification/nin').send({ nin: 'x' });
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(rows).toEqual([guardRefusal(staff)]);
  });

  it('refuses it before the CSRF check, so a wrong token is answered as the wrong session', async () => {
    const response = await withCookie('post', `identity/access-requests/${ID}/approve`, { 'X-CSRF-Token': 'wrong' });
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(rows).toEqual([guardRefusal(staff)]);
  });

  it('refuses it before binding a facility named in X-Facility-ID, recorded without that facility', async () => {
    const response = await withCookie('get', 'identity/me', { 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(rows).toEqual([guardRefusal(staff)]);
    expect(rows[0]?.details).toEqual(expect.objectContaining({ method: 'GET', route: '/api/v1/identity/me' }));
  });

  it('refuses a platform administration token sent as a bearer token the same way', async () => {
    liveActor = platformActor();
    const response = await request(app.getHttpServer()).get('/api/v1/identity/me').set('Authorization', 'Bearer access-live');
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(rows).toEqual([guardRefusal(liveActor)]);
  });

  it('refuses a staff session without MFA assurance (0088) the same way, before the staff MFA check', async () => {
    // A staff sign-in from before staff MFA, or one whose authenticator was
    // reset: the route serves only a patient session whatever the staff
    // session's assurance, so the patient-only answer decides first. Elsewhere
    // the same session is answered 403 STAFF_MFA_REQUIRED.
    mfaAssured = false;
    const response = await withCookie('post', `identity/access-requests/${ID}/approve`);
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(rows).toEqual([guardRefusal(staff)]);
    expect(served()).toEqual([]);
    const probe = await withCookie('get', 'probe/refused');
    expect({ status: probe.status, code: probe.body.code }).toEqual({ status: 403, code: 'STAFF_MFA_REQUIRED' });
  });

  it('still fails closed with 503 DEPENDENCY_UNAVAILABLE and no row when the refusal cannot be audited', async () => {
    faults.audit = new Error('Connection terminated unexpectedly');
    const response = await withCookie('get', 'identity/me');
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    expect(rows).toEqual([]);
  });
});

describe('a patient session on a patient-only route (A9 regression pins)', () => {
  beforeEach(() => { liveActor = patient; });

  it('reads GET /identity/me, recording no success row (failures only)', async () => {
    const response = await withCookie('get', 'identity/me');
    expect(response.status).toBe(200);
    expect(rows).toEqual([]);
    expect(served()).toEqual(['self.profile']);
  });

  it('approves an access request, recorded as the patient\'s api.* success', async () => {
    const response = await withCookie('post', `identity/access-requests/${ID}/approve`);
    expect(response.status).toBe(200);
    expect(rows).toEqual([expect.objectContaining({ actorType: 'patient', actorSubject: patient.subject,
      action: 'api.identity.access-request.approve.command', resourceType: 'http-request', outcome: 'success',
      facilityId: null })]);
  });

  it('is refused 403 WORKLOAD_AUTHENTICATION_REQUIRED on the patient-self authorization without the EHR workload', async () => {
    const response = await withCookie('get', 'identity/service/patient-self-authorization');
    expect({ status: response.status, code: response.body.code })
      .toEqual({ status: 403, code: 'WORKLOAD_AUTHENTICATION_REQUIRED' });
    expect(rows).toEqual([expect.objectContaining({ actorType: 'patient',
      action: 'api.get./api/v1/identity/service/patient-self-authorization', resourceType: 'http-request',
      facilityId: null })]);
  });
});

describe('a handler refusal for a staff session with no bound facility (A9 interceptor defence in depth)', () => {
  /**
   * The interceptor's row for it: a facility-less auth event on authentication,
   * auth.authorization.denied for a refusal and auth.request.failed for a fault,
   * keeping the request's api.* action in details.requestAction.
   */
  const interceptorRow = (route: string, action: string, outcome: string, status: number) => expect.objectContaining({
    actorType: 'staff', actorSubject: staff.subject, actorAccountId: staff.accountId, action, resourceType: 'authentication',
    outcome, facilityId: null, actorMembershipId: null, organizationId: null, patientId: null,
    details: expect.objectContaining({ method: 'GET', route, status, requestAction: `api.get.${route}` }) });

  it('answers the handler\'s own 403 and records it as a facility-less auth.authorization.denied', async () => {
    const response = await withCookie('get', 'probe/refused');
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'PROBE_REFUSED' });
    expect(rows).toEqual([interceptorRow('/api/v1/probe/refused', 'auth.authorization.denied', 'denied', 403)]);
  });

  it('answers a handler fault 500 with its generic detail and records it as a facility-less auth.request.failed', async () => {
    const response = await withCookie('get', 'probe/fault');
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
    expect(response.body.detail).toBe('The service could not complete the request.');
    expect(rows).toEqual([interceptorRow('/api/v1/probe/fault', 'auth.request.failed', 'failure', 500)]);
    expect(JSON.stringify(rows)).not.toContain('internal detail');
  });

  it('keeps the api.* row with the facility the guard bound from X-Facility-ID', async () => {
    const response = await withCookie('get', 'probe/refused', { 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response.status).toBe(403);
    expect(rows).toEqual([expect.objectContaining({ actorSubject: staff.subject, action: 'api.get./api/v1/probe/refused',
      resourceType: 'http-request', facilityId: DEFAULT_FACILITY.id,
      actorMembershipId: DEFAULT_FACILITY.membershipId, organizationId: DEFAULT_FACILITY.organizationId })]);
  });

  it('records a patient\'s handler refusal as the patient\'s api.* row', async () => {
    liveActor = patient;
    const response = await withCookie('get', 'probe/refused');
    expect(response.status).toBe(403);
    expect(rows).toEqual([expect.objectContaining({ actorType: 'patient', action: 'api.get./api/v1/probe/refused',
      resourceType: 'http-request', facilityId: null })]);
  });
});
