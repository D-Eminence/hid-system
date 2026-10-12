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
const OTHER_FACILITY = '30000000-0000-4000-8000-000000000099';

/** A staff actor as CurrentStaffContextService builds it: no `kind`, its default facility attached. */
const staff = { id: 'staff:s', subject: 'staff:s', accountId: '20000000-0000-4000-8000-0000000000b1', sessionId: SESSION,
  roles: ['clinician'], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [DEFAULT_FACILITY.id],
  facilities: [DEFAULT_FACILITY], facility: DEFAULT_FACILITY, authenticationMethod: 'local' } as unknown as ActorContext;
const patient = { ...staff, id: 'patient:p', subject: 'patient:p', kind: 'patient', facility: undefined, facilities: [],
  facilityIds: [] } as unknown as ActorContext;

/** The audit row as AuditService writes it, by column. */
interface Row { actorType: string; actorSubject: string | null; actorMembershipId: string | null; organizationId: string | null;
  facilityId: string | null; action: string; resourceType: string | null; resourceId: string | null; outcome: string }

/**
 * A database that keeps the rows written and, like audit.events, refuses a
 * staff row that 0067's events_staff_facility_scope_check and
 * events_staff_membership_scope_check refuse.
 */
function auditDatabase(rows: Row[]) {
  return {
    query: jest.fn(async (_sql: string, values: unknown[]) => {
      const row = { actorType: values[1], actorSubject: values[2], actorMembershipId: values[4], organizationId: values[5],
        facilityId: values[6], action: values[8], resourceType: values[9], resourceId: values[10], outcome: values[11] } as Row
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
 * actor (with its default facility) and no bound facility.
 */
class GuardAsDeployed implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly signedIn: () => ActorContext) {}
  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true
    if (!this.reflector.getAllAndOverride<boolean>(FACILITY_OPTIONAL, targets)) throw new Error('not exercised here')
    const request = context.switchToHttp().getRequest<HidRequest>()
    request.actor = this.signedIn()
    request.accessScope = 'facility'
    return true
  }
}

let app: INestApplication
let rows: Row[]
let liveActor: ActorContext

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
      return { actor: liveActor, claims: { csrf_hash: 'hash-of-csrf-live' } }
    }),
    verifyCsrf: jest.fn((claims: { csrf_hash: string }, cookie?: string, header?: string) =>
      Boolean(cookie) && cookie === header && claims.csrf_hash === `hash-of-${cookie}`),
    verifyRefreshCsrf: jest.fn(() => false),
    refreshSessionKind: jest.fn(async () => undefined),
  }
  const auth = { revoke: jest.fn().mockResolvedValue(true), revokeByRefreshToken: jest.fn() }
  const module = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: TokenService, useValue: tokens },
      { provide: AuthSessionAuditService, useValue: { record: jest.fn() } },
      { provide: AuditService, useFactory: () => new AuditService(auditDatabase(rows)) },
      { provide: WorkloadAuthService, useValue: {} },
      { provide: TurnstileService, useValue: {} },
      { provide: GoogleAuthenticationService, useValue: {} },
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

  it('records a patient\'s refused sign-out as before, as the patient', async () => {
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
