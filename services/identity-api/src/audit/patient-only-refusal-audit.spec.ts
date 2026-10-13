jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PatientSelfController } from '../auth/patient-self.controller';
import { PatientSelfService } from '../auth/patient-self.service';
import { SecurityGuard } from '../auth/security.guard';
import type { TokenService } from '../auth/token.service';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { FacilityOptional, PatientAllowed } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

// A9: a staff cookie on a patient-only route was refused in the handler. The
// AuditInterceptor recorded that refusal as a staff api.* request without a
// facility, which AuditService and the 0067 CHECKs refuse, so the answer
// became 503 DEPENDENCY_UNAVAILABLE and nothing was recorded. These tests run
// the real guard, interceptor, audit service and problem filter, as AppModule
// and main.ts register them, over a database that refuses what 0067 refuses.

const facility: FacilityAssignment = {
  id: '10000000-0000-4000-8000-00000000000a', membershipId: '40000000-0000-4000-8000-00000000000a',
  organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A', roles: ['doctor'], permissions: [],
  isPrimary: true,
};
/** A staff actor as Identity resolves it: its default facility attached, none bound to the request. */
const staff = { kind: 'staff', id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
  sessionId: '90000000-0000-4000-8000-000000000001', roles: ['doctor'], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: [facility.id], facilities: [facility], facility, authenticationMethod: 'local',
} as unknown as ActorContext;
const patient = { kind: 'patient', id: 'patient:ada', subject: 'patient:ada', accountId: '20000000-0000-4000-8000-0000000000c1',
  patientId: '50000000-0000-4000-8000-000000000001', sessionId: '90000000-0000-4000-8000-0000000000c1', roles: [],
  permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local',
} as unknown as ActorContext;

@Controller('identity/probe')
class FacilityOptionalProbeController {
  /** A facility-optional staff route whose handler refuses: the interceptor's defence in depth. */
  @Get('refusal')
  @FacilityOptional()
  @PatientAllowed()
  refuse() { throw new DomainProblem(403, 'PROBE_REFUSED', 'The probe refuses every request'); }
}

interface Row { actorType: unknown; actorSubject: unknown; actorMembershipId: unknown; organizationId: unknown;
  facilityId: unknown; action: unknown; resourceType: unknown; outcome: unknown }

/** audit.events as 0067 constrains it: a staff row without a facility only as an auth.* authentication or session event. */
function auditDatabase(rows: Row[]) {
  return {
    query: jest.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }], rowCount: 1 };
      if (!sql.includes('insert into audit.events')) throw new Error(`unexpected query: ${sql}`);
      const row: Row = { actorType: values[1], actorSubject: values[2], actorMembershipId: values[4], organizationId: values[5],
        facilityId: values[6], action: values[8], resourceType: values[9], outcome: values[11] };
      const staffRow = row.actorType === 'staff';
      const authEvent = String(row.action).startsWith('auth.') && ['authentication', 'session'].includes(String(row.resourceType));
      if (staffRow && row.facilityId === null && !authEvent) throw Object.assign(new Error('check violation'), { code: '23514' });
      if (staffRow && !String(row.action).startsWith('auth.') && (row.actorMembershipId === null || row.facilityId === null)) {
        throw Object.assign(new Error('check violation'), { code: '23514' });
      }
      rows.push(row);
      return { rows: [], rowCount: 1 };
    }),
  };
}

describe('refusals on facility-optional routes are answered and audited, never 503 (A9)', () => {
  let app: INestApplication;
  let rows: Row[];
  let actor: ActorContext;

  beforeAll(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local', STORAGE_MODE: 'disabled',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    resetEnvironmentForTests();
  });
  afterAll(() => resetEnvironmentForTests());

  beforeEach(async () => {
    rows = [];
    actor = staff;
    const database = auditDatabase(rows);
    const audit = new AuditService(database as unknown as DatabaseService);
    const tokens = { verify: jest.fn(async () => ({ actor, claims: {}, mfaAssured: true })), verifyCsrf: jest.fn(() => true) };
    const self = { profile: jest.fn(async (request: HidRequest) => ({ patientId: request.actor?.patientId })),
      history: jest.fn(async () => ({ items: [] })), notificationInbox: jest.fn(async () => ({ items: [] })) };
    const moduleRef = await Test.createTestingModule({ controllers: [PatientSelfController, FacilityOptionalProbeController],
      providers: [{ provide: PatientSelfService, useValue: self }, { provide: WorkloadAuthService, useValue: {} }] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: HidRequest, _res: unknown, next: () => void) => { req.correlationId = 'auth-refusal-audit-test'; next(); });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalGuards(new SecurityGuard(new Reflector(), tokens as unknown as TokenService, audit,
      database as unknown as DatabaseService));
    app.useGlobalInterceptors(new AuditInterceptor(new Reflector(), audit));
    await app.init();
  });
  afterEach(() => app.close());

  it.each(['/api/v1/identity/me', '/api/v1/identity/me/access-history', '/api/v1/identity/me/notifications'])(
    'GET %s with a staff session answers 403 PATIENT_SESSION_REQUIRED with exactly one refusal row', async (path) => {
      const response = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer staff-token');
      expect([response.status, response.body.code]).toEqual([403, 'PATIENT_SESSION_REQUIRED']);
      expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', actorSubject: staff.subject,
        action: 'auth.authorization.denied', resourceType: 'authentication', outcome: 'denied', facilityId: null,
        actorMembershipId: null, organizationId: null })]);
    });

  it('still answers a patient session on its own route', async () => {
    actor = patient;
    const response = await request(app.getHttpServer()).get('/api/v1/identity/me').set('Authorization', 'Bearer patient-token');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ patientId: patient.patientId });
  });

  it('records a handler refusal of a staff request without a facility as an auth event, answering its own status', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/identity/probe/refusal')
      .set('Authorization', 'Bearer staff-token');
    expect([response.status, response.body.code]).toEqual([403, 'PROBE_REFUSED']);
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.authorization.denied',
      resourceType: 'authentication', facilityId: null, actorMembershipId: null, organizationId: null })]);
  });
});
