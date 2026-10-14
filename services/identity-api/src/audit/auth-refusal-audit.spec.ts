jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { type CanActivate, type ExecutionContext, type INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';
import { FACILITY_OPTIONAL, PUBLIC_ROUTE } from '../common/decorators';
import { ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { AuthController } from './../auth/auth.controller';
import { AuthService } from './../auth/auth.service';
import { AuthSessionAuditService } from './../auth/auth-session-audit.service';
import { GoogleAuthenticationService } from './../auth/google-authentication.service';
import { MfaService } from './../auth/mfa/mfa.service';
import { TokenService } from './../auth/token.service';
import { TurnstileService } from './../auth/turnstile.service';
import { WorkloadAuthService } from './../auth/workload-auth.service';

// A refused request on a session route (sign-out, facility selection) made with
// a staff sign-in answered 503 DEPENDENCY_UNAVAILABLE instead of its refusal.
// No facility is bound to these routes, the global AuditInterceptor recorded
// the refusal as a generic `api.*` HTTP request for the staff actor, and staff
// audit rows without a facility are accepted only as `auth.*` session events
// (AuditService.assertActorFacility; CHECK constraints from migration 0067).
// The audit write failed closed, so the refusal was neither answered nor
// recorded. These tests run the real interceptor, audit service and problem
// filter, as AppModule and main.ts register them.

const ORIGIN = 'https://www.healthidentitydirectory.com';
const SESSION = '90000000-0000-4000-8000-0000000000b1';
const DEFAULT_FACILITY = { id: '30000000-0000-4000-8000-000000000001', membershipId: '40000000-0000-4000-8000-000000000001',
  organizationId: '50000000-0000-4000-8000-000000000001', name: 'Lagos General', roles: ['clinician'], permissions: [], isPrimary: true };
const SECOND_FACILITY = { id: '30000000-0000-4000-8000-000000000002', membershipId: '40000000-0000-4000-8000-000000000002',
  organizationId: '50000000-0000-4000-8000-000000000002', name: 'Ikeja Clinic', roles: ['clinician'], permissions: [], isPrimary: false };
const OTHER_FACILITY = '30000000-0000-4000-8000-000000000099';

/** A staff actor as CurrentStaffContextService builds it: no `kind`, its default facility attached. */
const staff = { id: 'staff:s', subject: 'staff:s', accountId: '20000000-0000-4000-8000-0000000000b1', sessionId: SESSION,
  roles: ['clinician'], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [DEFAULT_FACILITY.id, SECOND_FACILITY.id],
  facilities: [DEFAULT_FACILITY, SECOND_FACILITY], facility: DEFAULT_FACILITY, authenticationMethod: 'local' } as unknown as ActorContext;
const patient = { ...staff, id: 'patient:p', subject: 'patient:p', kind: 'patient', facility: undefined, facilities: [],
  facilityIds: [] } as unknown as ActorContext;

/** The audit row as AuditService writes it, by column. */
interface Row { actorType: string; actorSubject: string | null; actorMembershipId: string | null; organizationId: string | null;
  facilityId: string | null; action: string; resourceType: string | null; resourceId: string | null; outcome: string;
  purposeOfUse: string | null; details: Record<string, unknown> }

/**
 * A database that keeps the rows written and, like audit.events, refuses a
 * staff row that 0067's events_staff_facility_scope_check and
 * events_staff_membership_scope_check refuse.
 */
function auditDatabase(rows: Row[]) {
  return {
    query: jest.fn(async (_sql: string, values: unknown[]) => {
      const row = { actorType: values[1], actorSubject: values[2], actorMembershipId: values[4], organizationId: values[5],
        facilityId: values[6], action: values[8], resourceType: values[9], resourceId: values[10], outcome: values[11],
        purposeOfUse: values[12], details: JSON.parse(values[16] as string) } as Row
      const facilityScope = row.facilityId !== null || row.actorType !== 'staff'
        || (row.action.startsWith('auth.') && ['authentication', 'session'].includes(row.resourceType ?? ''))
      const membershipScope = row.actorType !== 'staff' || row.action.startsWith('auth.')
        || (row.actorMembershipId !== null && row.facilityId !== null)
      if (!facilityScope || !membershipScope) throw Object.assign(new Error('audit.events check violation'), { code: '23514' })
      rows.push(row)
      return { rows: [], rowCount: 1 }
    }),
  } as unknown as DatabaseService
}

/**
 * The SecurityGuard's effect, as far as these routes need it: public routes pass
 * untouched; a facility-optional route with no X-Facility-ID gets the verified
 * actor (with its default facility) and no bound facility; one with the
 * X-Facility-ID of one of the actor's facilities gets that facility bound.
 */
class GuardAsDeployed implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly signedIn: () => ActorContext) {}
  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true
    if (!this.reflector.getAllAndOverride<boolean>(FACILITY_OPTIONAL, targets)) throw new Error('not exercised here')
    const request = context.switchToHttp().getRequest<HidRequest>()
    const actor = this.signedIn()
    request.actor = actor
    const facilityId = request.header('x-facility-id')
    const assignment = actor.facilities.find(candidate => candidate.id === facilityId)
    if (facilityId && assignment) {
      request.facilityId = facilityId
      request.actor = { ...actor, facility: assignment, roles: assignment.roles, permissions: assignment.permissions }
    }
    request.accessScope = 'facility'
    return true
  }
}

let app: INestApplication
let rows: Row[]
let liveActor: ActorContext
/** The facility selection store (0089): the outcome of a write and the selection a read finds. */
let selections: { recordFacilitySelection: jest.Mock; selectedFacilityId: jest.Mock }

beforeEach(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: ORIGIN, AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'false',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', TURNSTILE_MODE: 'disabled' });
  resetEnvironmentForTests();
  rows = []
  liveActor = staff
  const tokens = {
    // "access-live" is a live access token for `liveActor`, with CSRF token "csrf-live".
    verify: jest.fn(async (token: string) => {
      if (token !== 'access-live') throw new UnauthorizedException('Invalid or expired access token')
      return { actor: liveActor, claims: { csrf_hash: 'hash-of-csrf-live' }, mfaAssured: true }
    }),
    verifyCsrf: jest.fn((claims: { csrf_hash: string }, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && claims.csrf_hash === `hash-of-${cookie}`),
    verifyRefreshCsrf: jest.fn(() => false),
    refreshSessionKind: jest.fn(async () => undefined),
    ...(selections = { recordFacilitySelection: jest.fn(async () => 'recorded'), selectedFacilityId: jest.fn(async () => undefined) }),
  }
  const auth = { revoke: jest.fn().mockResolvedValue(true), revokeByRefreshToken: jest.fn() }
  // A workload caller that fails its own authentication, as WorkloadAuthService refuses one.
  const workloads = { authenticateService: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid workload token')) }
  const module = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: TokenService, useValue: tokens },
      { provide: AuthSessionAuditService, useValue: { record: jest.fn() } },
      { provide: AuditService, useFactory: () => new AuditService(auditDatabase(rows)) },
      { provide: WorkloadAuthService, useValue: workloads },
      { provide: TurnstileService, useValue: {} },
      { provide: GoogleAuthenticationService, useValue: {} },
      { provide: MfaService, useValue: {} },
    ],
  }).compile()
  app = module.createNestApplication({ logger: false })
  app.use(cookieParser())
  app.setGlobalPrefix('api/v1')
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  app.useGlobalFilters(new ProblemDetailsFilter())
  const reflector = module.get(Reflector)
  app.useGlobalGuards(new GuardAsDeployed(reflector, () => liveActor))
  app.useGlobalInterceptors(new AuditInterceptor(reflector, module.get(AuditService)))
  await app.init()
})

afterEach(async () => { await app.close() })

const signOut = (headers: Record<string, string>) => request(app.getHttpServer()).post('/api/v1/auth/logout')
  .set('Origin', ORIGIN).set('Cookie', 'hid_access=access-live; hid_access_csrf=csrf-live').set(headers)

describe('a refused sign-out made with a live staff access cookie', () => {
  it('answers 403 SESSION_CLIENT_MISMATCH, keeps the cookies, and records an auth.logout refusal', async () => {
    const response = await signOut({ 'X-CSRF-Token': 'csrf-live', 'X-HID-Client': 'patient-web' })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('SESSION_CLIENT_MISMATCH')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', actorSubject: 'staff:s', action: 'auth.logout',
      resourceType: 'session', resourceId: SESSION, outcome: 'failure', facilityId: null, actorMembershipId: null, organizationId: null })])
  })

  it('answers 403 CSRF_VALIDATION_FAILED and records an auth.logout refusal', async () => {
    const response = await signOut({ 'X-CSRF-Token': 'wrong' })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('CSRF_VALIDATION_FAILED')
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.logout', resourceType: 'session', outcome: 'failure' })])
  })

  it('still signs out, recorded as before, when nothing is refused', async () => {
    const response = await signOut({ 'X-CSRF-Token': 'csrf-live', 'X-HID-Client': 'staff-web' })
    expect(response.status).toBe(204)
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.logout', outcome: 'success',
      facilityId: DEFAULT_FACILITY.id })])
  })

  it('records a patient\'s refused sign-out as an auth.logout session event, as the patient', async () => {
    liveActor = patient
    const response = await signOut({ 'X-CSRF-Token': 'csrf-live', 'X-HID-Client': 'staff-web' })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('SESSION_CLIENT_MISMATCH')
    expect(rows).toEqual([expect.objectContaining({ actorType: 'patient', action: 'auth.logout', outcome: 'failure' })])
  })
})

describe('a refused facility selection made with a staff session', () => {
  const select = (body: unknown) => request(app.getHttpServer()).post('/api/v1/auth/facility').set('Origin', ORIGIN).send(body as object)

  it('answers 403 FACILITY_ACCESS_DENIED for a facility the actor has no membership at, and records the refusal', async () => {
    const response = await select({ facilityId: OTHER_FACILITY })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('FACILITY_ACCESS_DENIED')
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.facility.select', resourceType: 'session',
      resourceId: SESSION, outcome: 'failure', facilityId: null, actorMembershipId: null })])
  })

  it('answers 400 for a malformed facility id, and records the refusal', async () => {
    const response = await select({ facilityId: 'not-a-uuid' })
    expect(response.status).toBe(400)
    expect(rows).toEqual([expect.objectContaining({ action: 'auth.facility.select', outcome: 'failure' })])
  })
})

describe('refusals on the other session routes, made with a staff session', () => {
  const GOOGLE_LINK = { idToken: 'x'.repeat(40), turnstileAction: 'patient-login', principal: 'HID-ABCDEF23', password: 'a-password' }
  const link = (body: unknown) => request(app.getHttpServer()).post('/api/v1/auth/google/link').set('Origin', ORIGIN).send(body as object)

  it('POST /auth/google/link answers 403 PATIENT_SCOPE_DENIED and records an auth.google.link refusal', async () => {
    const response = await link(GOOGLE_LINK)
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('PATIENT_SCOPE_DENIED')
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.google.link', resourceType: 'session',
      resourceId: SESSION, outcome: 'failure', facilityId: null, actorMembershipId: null, organizationId: null })])
  })

  it('POST /auth/google/link with a malformed body answers 400 and records the refusal', async () => {
    const response = await link({})
    expect(response.status).toBe(400)
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.google.link', outcome: 'failure' })])
  })

  it.each([
    ['GET', 'auth.service-session.read'],
    ['POST', 'auth.service-session.validate'],
  ])('%s /auth/service-session with a refused workload answers 401 and records %s', async (method, action) => {
    const call = method === 'GET' ? request(app.getHttpServer()).get('/api/v1/auth/service-session')
      : request(app.getHttpServer()).post('/api/v1/auth/service-session').send({})
    const response = await call.set('X-HID-Internal-Caller', 'ehr-api').set('X-HID-Service-Token', 'not-a-token')
    expect(response.status).toBe(401)
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action, resourceType: 'session', resourceId: SESSION,
      outcome: 'failure', facilityId: null, actorMembershipId: null })])
  })

  it('records the facility the guard bound from X-Facility-ID, with its membership and organization', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/facility').set('Origin', ORIGIN)
      .set('X-Facility-ID', SECOND_FACILITY.id).send({ facilityId: OTHER_FACILITY })
    expect(response.status).toBe(403)
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.facility.select', outcome: 'failure',
      facilityId: SECOND_FACILITY.id, actorMembershipId: SECOND_FACILITY.membershipId, organizationId: SECOND_FACILITY.organizationId })])
  })
})

describe('refusal rows on the session routes record the answered status and code (A17)', () => {
  const select = (body: unknown) => request(app.getHttpServer()).post('/api/v1/auth/facility').set('Origin', ORIGIN).send(body as object)

  it('records a refused sign-out with 403 SESSION_CLIENT_MISMATCH, and no purpose for a staff session', async () => {
    const response = await signOut({ 'X-CSRF-Token': 'csrf-live', 'X-HID-Client': 'patient-web' })
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'SESSION_CLIENT_MISMATCH' })
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.logout', purposeOfUse: null })])
    expect(rows[0]?.details).toEqual({ method: 'POST', route: '/api/v1/auth/logout', status: 403, code: 'SESSION_CLIENT_MISMATCH',
      durationMs: expect.any(Number) })
  })

  it('records a patient\'s refused sign-out with its code and purpose patient-self, whatever purpose is sent', async () => {
    liveActor = patient
    const response = await signOut({ 'X-CSRF-Token': 'csrf-live', 'X-HID-Client': 'staff-web', 'X-Purpose-Of-Use': 'direct-care' })
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 403, code: 'SESSION_CLIENT_MISMATCH' })
    expect(rows).toEqual([expect.objectContaining({ actorType: 'patient', action: 'auth.logout', purposeOfUse: 'patient-self' })])
    expect(rows[0]?.details).toEqual(expect.objectContaining({ status: 403, code: 'SESSION_CLIENT_MISMATCH' }))
  })

  it('records a malformed facility id with the 400 and code it is answered', async () => {
    const response = await select({ facilityId: 'not-a-uuid' })
    expect(response.status).toBe(400)
    expect(rows).toEqual([expect.objectContaining({ action: 'auth.facility.select', resourceId: SESSION })])
    expect(rows[0]?.details).toEqual({ method: 'POST', route: '/api/v1/auth/facility', status: 400, code: response.body.code,
      durationMs: expect.any(Number) })
  })

  it.each([
    ['the sign-in ended while the selection waited (0089)', 'session_ended', 401, 'AUTHENTICATION_REQUIRED'],
    ['the membership ended while the selection waited (0089)', 'refused', 403, 'FACILITY_ACCESS_DENIED'],
  ])('records a selection refused because %s with its status and code', async (_case, outcome, status, code) => {
    selections.recordFacilitySelection.mockResolvedValue(outcome)
    const response = await select({ facilityId: SECOND_FACILITY.id })
    expect({ status: response.status, code: response.body.code }).toEqual({ status, code })
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.facility.select', resourceType: 'session',
      resourceId: SESSION, facilityId: null, actorMembershipId: null })])
    expect(rows[0]?.details).toEqual({ method: 'POST', route: '/api/v1/auth/facility', status, code,
      durationMs: expect.any(Number) })
  })

  it('records GET /auth/session answered 503 when the selection cannot be read, with nothing from the fault', async () => {
    selections.selectedFacilityId.mockRejectedValue(new Error('permission denied for table session_facility_selection'))
    const response = await request(app.getHttpServer()).get('/api/v1/auth/session')
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' })
    expect(rows).toEqual([expect.objectContaining({ actorType: 'staff', action: 'auth.session.read', resourceType: 'session',
      resourceId: SESSION, outcome: 'failure', facilityId: null })])
    expect(rows[0]?.details).toEqual({ method: 'GET', route: '/api/v1/auth/session', status: 503,
      code: 'DEPENDENCY_UNAVAILABLE', durationMs: expect.any(Number) })
    expect(JSON.stringify(rows)).not.toContain('permission denied')
  })
})
