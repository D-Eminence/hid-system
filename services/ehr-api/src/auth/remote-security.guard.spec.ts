import { Controller, Get, type INestApplication, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { IdentityActorContext } from '@hid/api-client';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { FacilityOptional, PatientAllowed, RequirePermissions } from '../common/decorators';
import { CorrelationMiddleware } from '../common/correlation.middleware';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import { DatabaseService } from '../database/database.service';
import { PatientRecordsController } from '../ehr/patient-records/patient-records.controller';
import { PatientRecordsService } from '../ehr/patient-records/patient-records.service';
import { IdentityApiService } from '../integrations/identity-api.service';
import { RemoteSecurityGuard } from './remote-security.guard';

// A staff request the guard refused before it bound a facility (no or
// malformed X-Facility-ID, a facility the actor is no longer active at, a
// disabled portal) answered 503 DEPENDENCY_UNAVAILABLE instead of its refusal.
// The guard recorded it as a `security.authorization.denied` http-request with
// the membership and organization of the actor's default facility but no
// facility, and a staff row without a facility is accepted only as an `auth.*`
// event on authentication or session (AuditService.assertActorFacility; CHECK
// constraints from migration 0067). The audit write failed closed, so the
// refusal was neither answered nor recorded. These tests run the real guard,
// audit interceptor, audit service and problem filter, as AppModule and
// main.ts register them, over a database that refuses what 0067 refuses.

const DEFAULT_FACILITY = { id: '30000000-0000-4000-8000-000000000001', membershipId: '40000000-0000-4000-8000-000000000001',
  organizationId: '50000000-0000-4000-8000-000000000001', name: 'Lagos General', roles: ['clinician'],
  permissions: ['ehr.encounter.read'], isPrimary: true };
const SECOND_FACILITY = { id: '30000000-0000-4000-8000-000000000002', membershipId: '40000000-0000-4000-8000-000000000002',
  organizationId: '50000000-0000-4000-8000-000000000002', name: 'Ikeja Clinic', roles: ['receptionist'], permissions: [],
  isPrimary: false };
const OTHER_FACILITY = '30000000-0000-4000-8000-000000000099';

/** A staff actor as Identity's service session returns it: its default facility attached, none bound. */
const staff: IdentityActorContext = { kind: 'staff', id: 'staff:s', subject: 'staff:s', accountId: '20000000-0000-4000-8000-0000000000b1',
  roles: ['clinician'], permissions: ['ehr.encounter.read'], platformRoles: [], platformPermissions: [],
  facilityIds: [DEFAULT_FACILITY.id, SECOND_FACILITY.id], facilities: [DEFAULT_FACILITY, SECOND_FACILITY],
  facility: DEFAULT_FACILITY, role: 'clinician', authenticationMethod: 'local' };
const patient: IdentityActorContext = { kind: 'patient', patientId: '60000000-0000-4000-8000-000000000001', id: 'patient:p',
  subject: 'patient:p', accountId: '20000000-0000-4000-8000-0000000000c1', roles: [], permissions: [], facilityIds: [],
  facilities: [], authenticationMethod: 'local' };

/** The audit row as AuditService writes it, by column. */
interface Row { actorType: string; actorSubject: string | null; actorAccountId: string | null; actorMembershipId: string | null;
  organizationId: string | null; facilityId: string | null; action: string; resourceType: string | null; outcome: string;
  sourceIp: string | null; userAgent: string | null; details: Record<string, unknown>; provenance: string }

/** Faults to inject: each is thrown by the query it names instead of answering it. */
interface Faults { control?: unknown; audit?: unknown }

const USER_AGENT = 'hid-guard-spec/1.0';

/**
 * A database that answers the guard's runtime controls from `controls`, keeps
 * the audit rows written and, like audit.events, refuses a staff row that
 * 0067's events_staff_facility_scope_check and
 * events_staff_membership_scope_check refuse.
 */
function auditDatabase(rows: Row[], controls: Record<string, boolean>, faults: Faults) {
  return {
    query: jest.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('platform.control_enabled')) {
        if (faults.control) throw faults.control;
        return { rows: [{ enabled: controls[values[0] as string] === true }], rowCount: 1 };
      }
      if (!sql.includes('insert into audit.events')) throw new Error(`unexpected query: ${sql}`);
      if (faults.audit) throw faults.audit;
      const row = { actorType: values[1], actorSubject: values[2], actorAccountId: values[3], actorMembershipId: values[4],
        organizationId: values[5], facilityId: values[6], action: values[8], resourceType: values[9], outcome: values[11],
        sourceIp: values[13], userAgent: values[14], details: JSON.parse(values[15] as string), provenance: values[16] } as Row;
      const facilityScope = row.facilityId !== null || row.actorType !== 'staff'
        || (row.action.startsWith('auth.') && ['authentication', 'session'].includes(row.resourceType ?? ''));
      const membershipScope = row.actorType !== 'staff' || row.action.startsWith('auth.')
        || (row.actorAccountId !== null && row.actorMembershipId !== null && row.facilityId !== null);
      if (!facilityScope || !membershipScope) throw Object.assign(new Error('audit.events check violation'), { code: '23514' });
      rows.push(row);
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as DatabaseService;
}

@Controller('probe')
class ProbeController {
  @Get()
  @RequirePermissions('ehr.encounter.read')
  read() { return { ok: true }; }

  /** A command refused after its facility was bound, as a stale clinical update is. */
  @Get('stale')
  @RequirePermissions('ehr.encounter.read')
  stale() { throw new DomainProblem(412, 'VERSION_CONFLICT', 'Encounter changed since it was loaded'); }

  /** A handler fault: no status or code of its own. */
  @Get('fault')
  @RequirePermissions('ehr.encounter.read')
  fault() { throw new Error('synthetic handler fault'); }

  /** A facility-optional route whose handler refuses a staff actor itself. */
  @Get('facility-optional')
  @FacilityOptional()
  @PatientAllowed()
  facilityOptional() { throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required'); }
}

let app: INestApplication;
let baseUrl: string;
let rows: Row[];
let controls: Record<string, boolean>;
let faults: Faults;
let liveActor: IdentityActorContext | undefined;
/** A refusal Identity's /auth/service-session answers with, as IdentityApiService translates it, or a fault. */
let identityRefusal: unknown;
/** The patient records service behind GET /ehr/me/records: it refuses a non-patient itself, as the real one does. */
let records: { self: jest.Mock; emergency: jest.Mock };

beforeEach(async () => {
  rows = [];
  identityRefusal = undefined;
  controls = { maintenance_mode: false, provider_portal_enabled: true, patient_portal_enabled: true };
  faults = {};
  liveActor = staff;
  const identity = {
    authenticateRequest: jest.fn(async () => {
      if (identityRefusal) throw identityRefusal;
      if (!liveActor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
      return liveActor;
    }),
  };
  const database = auditDatabase(rows, controls, faults);
  records = {
    self: jest.fn(async (request: { actor?: IdentityActorContext }) => {
      if (request.actor?.kind !== 'patient') {
        throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
      }
      return { encounters: [], notes: [] };
    }),
    emergency: jest.fn(),
  };

  @Module({
    controllers: [ProbeController, PatientRecordsController],
    providers: [
      AuditService,
      { provide: PatientRecordsService, useValue: records },
      { provide: DatabaseService, useValue: database },
      { provide: IdentityApiService, useValue: identity },
      { provide: APP_GUARD, useClass: RemoteSecurityGuard },
      { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    ],
  })
  class ProbeModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
    }
  }

  const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterEach(async () => { await app.close(); });

function probe(headers: Record<string, string> = {}): Promise<{ status: number; code?: string }> {
  return probeAt('/api/v1/probe', headers);
}

function probeAt(path: string, headers: Record<string, string> = {}): Promise<{ status: number; code?: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${baseUrl}${path}`, { headers: { 'User-Agent': USER_AGENT, ...headers } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, code: (JSON.parse(text) as { code?: string }).code }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/**
 * The request evidence every guard refusal row carries: the method and route,
 * and since A17 the status and code the refusal answered.
 */
const requestEvidence = (status: number, code: string, route = '/api/v1/probe') =>
  ({ sourceIp: '127.0.0.1', userAgent: USER_AGENT, details: { method: 'GET', route, status, code } });

/** Identity's SecurityGuard records a refusal with no bound facility this way. */
const refusedBeforeFacility = (actor: IdentityActorContext, actorType: 'staff' | 'patient', status: number, code: string,
  route?: string) => expect.objectContaining({
  actorType, actorSubject: actor.subject, actorAccountId: actor.accountId, action: 'auth.authorization.denied',
  resourceType: 'authentication', outcome: 'denied', facilityId: null, actorMembershipId: null, organizationId: null,
  provenance: 'application', ...requestEvidence(status, code, route) });

describe('RemoteSecurityGuard refusals before a facility is bound', () => {
  it.each([
    ['no X-Facility-ID', {}],
    ['a malformed X-Facility-ID', { 'X-Facility-ID': 'not-a-uuid' }],
  ])('answers 400 FACILITY_REQUIRED for %s and records an auth.authorization.denied row', async (_case, headers) => {
    const response = await probe(headers);
    expect(response).toEqual({ status: 400, code: 'FACILITY_REQUIRED' });
    expect(rows).toEqual([refusedBeforeFacility(staff, 'staff', 400, 'FACILITY_REQUIRED')]);
  });

  it('answers 403 FACILITY_ACCESS_DENIED for a facility the actor is not active at and records the refusal', async () => {
    const response = await probe({ 'X-Facility-ID': OTHER_FACILITY });
    expect(response).toEqual({ status: 403, code: 'FACILITY_ACCESS_DENIED' });
    expect(rows).toEqual([refusedBeforeFacility(staff, 'staff', 403, 'FACILITY_ACCESS_DENIED')]);
  });

  it('answers 423 PLATFORM_PORTAL_DISABLED when the provider portal is disabled and records the refusal', async () => {
    controls.provider_portal_enabled = false;
    const response = await probe({ 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response).toEqual({ status: 423, code: 'PLATFORM_PORTAL_DISABLED' });
    expect(rows).toEqual([refusedBeforeFacility(staff, 'staff', 423, 'PLATFORM_PORTAL_DISABLED')]);
  });

  it('answers 503 PLATFORM_MAINTENANCE in maintenance mode and records the refusal', async () => {
    controls.maintenance_mode = true;
    const response = await probe({ 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response).toEqual({ status: 503, code: 'PLATFORM_MAINTENANCE' });
    expect(rows).toEqual([refusedBeforeFacility(staff, 'staff', 503, 'PLATFORM_MAINTENANCE')]);
  });

  it('records a patient refused on a workforce route as the patient', async () => {
    liveActor = patient;
    const response = await probe();
    expect(response).toEqual({ status: 403, code: 'PATIENT_SCOPE_DENIED' });
    expect(rows).toEqual([refusedBeforeFacility(patient, 'patient', 403, 'PATIENT_SCOPE_DENIED')]);
  });

  it.each([
    ['the patient portal disabled', { patient_portal_enabled: false }, 423, 'PLATFORM_PORTAL_DISABLED'],
    ['maintenance mode', { maintenance_mode: true }, 503, 'PLATFORM_MAINTENANCE'],
  ])('records a patient refused by the runtime controls (%s) as the patient', async (_case, changed, status, code) => {
    liveActor = patient;
    Object.assign(controls, changed);
    const response = await probe();
    expect(response).toEqual({ status, code });
    expect(rows).toEqual([refusedBeforeFacility(patient, 'patient', status, code)]);
  });

  it.each([
    ['a statement timeout (57014)', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['a lost connection (no code)', new Error('Connection terminated unexpectedly')],
    ['a missing grant (42501)', Object.assign(new Error('permission denied for function control_enabled'), { code: '42501' })],
    ['an unavailable control (55000)', Object.assign(new Error('PLATFORM_CONTROL_UNAVAILABLE'), { code: '55000' })],
  ])('answers 503 PLATFORM_CONTROL_UNAVAILABLE when the control check fails with %s and records the refusal', async (_case, fault) => {
    faults.control = fault;
    const response = await probe({ 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response).toEqual({ status: 503, code: 'PLATFORM_CONTROL_UNAVAILABLE' });
    expect(rows).toEqual([refusedBeforeFacility(staff, 'staff', 503, 'PLATFORM_CONTROL_UNAVAILABLE')]);
  });

  it('answers a patient 503 PLATFORM_CONTROL_UNAVAILABLE, not 401, when the control check fails', async () => {
    liveActor = patient;
    faults.control = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const response = await probe();
    expect(response).toEqual({ status: 503, code: 'PLATFORM_CONTROL_UNAVAILABLE' });
    expect(rows).toEqual([refusedBeforeFacility(patient, 'patient', 503, 'PLATFORM_CONTROL_UNAVAILABLE')]);
  });

  it('fails closed with 503 DEPENDENCY_UNAVAILABLE and no row when the refusal cannot be audited', async () => {
    faults.audit = new Error('Connection terminated unexpectedly');
    const response = await probe();
    expect(response).toEqual({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    expect(rows).toEqual([]);
  });
});

describe('RemoteSecurityGuard requests that bind a facility, or have no actor', () => {
  it('passes a request for the actor\'s own facility, audited with that facility\'s membership', async () => {
    const response = await probe({ 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response.status).toBe(200);
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'api.get./api/v1/probe', outcome: 'success',
      facilityId: DEFAULT_FACILITY.id, actorMembershipId: DEFAULT_FACILITY.membershipId,
      organizationId: DEFAULT_FACILITY.organizationId })]);
  });

  it('records a refusal after a facility is bound with that facility, its membership and organization', async () => {
    const response = await probe({ 'X-Facility-ID': SECOND_FACILITY.id });
    expect(response).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', actorSubject: staff.subject,
      action: 'security.authorization.denied', resourceType: 'http-request', outcome: 'denied', facilityId: SECOND_FACILITY.id,
      actorMembershipId: SECOND_FACILITY.membershipId, organizationId: SECOND_FACILITY.organizationId, provenance: 'application',
      ...requestEvidence(403, 'PERMISSION_DENIED') })]);
  });

  it('answers a staff session Identity refuses for missing MFA with Identity\'s 403 STAFF_MFA_REQUIRED (MFA-1)', async () => {
    // A staff sign-in from before staff MFA (0088), or one whose authenticator
    // was reset: Identity's guard authorizes nothing for it, and EHR passes
    // the refusal on instead of reading anything.
    identityRefusal = new DomainProblem(403, 'STAFF_MFA_REQUIRED', 'Sign in again with your authenticator code to continue');
    const response = await probe({ 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response).toEqual({ status: 403, code: 'STAFF_MFA_REQUIRED' });
    expect(rows).toEqual([expect.objectContaining({ actorType: 'system', action: 'security.authorization.denied',
      resourceType: 'authentication', outcome: 'denied', facilityId: null, provenance: 'system',
      ...requestEvidence(403, 'STAFF_MFA_REQUIRED') })]);
  });

  it('answers a fault with no status of its own 503 AUTHENTICATION_UNAVAILABLE, never a 401 that signs the user out (A4)', async () => {
    // Not a refusal of the credential: the guard could not decide. A 401
    // would end the browser's sign-in; the client retries a 503 instead.
    identityRefusal = new TypeError("Cannot read properties of undefined (reading 'facilities')");
    const response = await probe({ 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response).toEqual({ status: 503, code: 'AUTHENTICATION_UNAVAILABLE' });
    expect(rows).toEqual([expect.objectContaining({ actorType: 'system', action: 'security.authorization.denied',
      resourceType: 'authentication', outcome: 'denied', facilityId: null, provenance: 'system',
      ...requestEvidence(503, 'AUTHENTICATION_UNAVAILABLE') })]);
  });

  it('records an unauthenticated request as a system refusal', async () => {
    liveActor = undefined;
    const response = await probe({ 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response).toEqual({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(rows).toEqual([expect.objectContaining({ actorType: 'system', actorSubject: null,
      action: 'security.authorization.denied', resourceType: 'authentication', outcome: 'denied', facilityId: null,
      provenance: 'system', ...requestEvidence(401, 'AUTHENTICATION_REQUIRED') })]);
  });
});

// A staff session on the patient portal's GET /ehr/me/records answered 503
// DEPENDENCY_UNAVAILABLE with nothing audited (A9-EHR). The route was patient
// allowed and facility optional; its service refused the staff actor with 403
// PATIENT_SESSION_REQUIRED, and the interceptor then recorded that refusal as a
// staff http-request row with no facility, which the audit layer refuses, so
// the 503 replaced the 403. The guard now refuses a non-patient on a
// patient-only route before any handler runs, recorded as every refusal before
// a facility is bound.
describe('Patient-only routes refuse a staff session in the guard (A9-EHR)', () => {
  it.each([
    ['without X-Facility-ID', {}],
    ['with the staff member\'s own facility', { 'X-Facility-ID': DEFAULT_FACILITY.id }],
  ])('answers a staff session %s 403 PATIENT_SESSION_REQUIRED and records the refusal, before the handler', async (_case, headers) => {
    const response = await probeAt('/api/v1/ehr/me/records', headers);
    expect(response).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(rows).toEqual([refusedBeforeFacility(staff, 'staff', 403, 'PATIENT_SESSION_REQUIRED', '/api/v1/ehr/me/records')]);
    expect(records.self).not.toHaveBeenCalled();
  });

  it('still serves the patient their records, auditing no failure', async () => {
    liveActor = patient;
    const response = await probeAt('/api/v1/ehr/me/records');
    expect(response.status).toBe(200);
    expect(records.self).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([]);
  });

  it('records a handler refusal of a staff actor on a facility-optional route instead of answering 503', async () => {
    const response = await probeAt('/api/v1/probe/facility-optional');
    expect(response).toEqual({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', actorSubject: staff.subject,
      actorAccountId: staff.accountId, action: 'auth.authorization.denied', resourceType: 'authentication',
      outcome: 'denied', facilityId: null, actorMembershipId: null, organizationId: null,
      details: expect.objectContaining({ method: 'GET', route: '/api/v1/probe/facility-optional', status: 403,
        code: 'PATIENT_SESSION_REQUIRED' }) })]);
  });
});

// The interceptor's failure row said only "failure", with no status or code, so
// a refused clinical command could not be told from a fault (A17-EHR-AUDIT).
describe('AuditInterceptor failure rows carry the answered status and code (A17-EHR-AUDIT)', () => {
  it('records a 412 refusal after the facility is bound as denied, with its status and code', async () => {
    const response = await probeAt('/api/v1/probe/stale', { 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response).toEqual({ status: 412, code: 'VERSION_CONFLICT' });
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'api.get./api/v1/probe/stale',
      resourceType: 'http-request', outcome: 'denied', facilityId: DEFAULT_FACILITY.id,
      actorMembershipId: DEFAULT_FACILITY.membershipId,
      details: expect.objectContaining({ method: 'GET', route: '/api/v1/probe/stale', status: 412, code: 'VERSION_CONFLICT' }) })]);
  });

  it('records a handler fault as a failure with 500 INTERNAL_ERROR', async () => {
    const response = await probeAt('/api/v1/probe/fault', { 'X-Facility-ID': DEFAULT_FACILITY.id });
    expect(response).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
    expect(rows).toEqual([expect.objectContaining({ action: 'api.get./api/v1/probe/fault', outcome: 'failure',
      details: expect.objectContaining({ status: 500, code: 'INTERNAL_ERROR' }) })]);
  });
});
