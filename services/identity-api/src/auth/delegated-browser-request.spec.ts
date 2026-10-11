jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { IdentityController } from '../identity/identity.controller';
import { AuthController } from './auth.controller';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';
import type { WorkloadAuthService } from './workload-auth.service';

// EHR, OCR, Lab and Pharmacy authorize a browser request by POSTing to Identity
// with the browser's cookie. A same-origin browser GET carries no Origin and
// no X-CSRF-Token, so Identity refused every delegated read with ORIGIN_DENIED.

const ORIGIN = 'https://staging.healthidentitydirectory.com';
const facilityId = '10000000-0000-4000-8000-00000000000a';
const doctor: ActorContext = {
  id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001', kind: 'staff',
  sessionId: '90000000-0000-4000-8000-000000000001', roles: [], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: [facilityId], authenticationMethod: 'local',
  facilities: [{ id: facilityId, membershipId: '40000000-0000-4000-8000-00000000000a',
    organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A', roles: ['doctor'],
    permissions: ['identity.authorization.check'], isPrimary: true }],
} as unknown as ActorContext;

const authorizationCheck = IdentityController.prototype.authorizeService;
const serviceSessionMutation = AuthController.prototype.validateServiceMutation;

function request(headers: Record<string, string>, cookies: Record<string, string> = { hid_access: 'access-token',
  hid_access_csrf: 'csrf-token' }): HidRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { method: 'POST', correlationId: 'delegated-browser-request-test', ip: '127.0.0.1',
    route: { path: '/identity/service/authorization/check' }, cookies,
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function context(target: HidRequest, handler: (...args: never[]) => unknown, owner: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => target, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => handler, getClass: () => owner } as unknown as ExecutionContext;
}

function guard(workloadAuth: Partial<WorkloadAuthService> | null = {
  authenticateService: jest.fn(async (caller?: string, _authorization?: string, token?: string) => {
    if (caller !== 'ehr-api' || token !== 'valid-workload-token') throw new Error('workload refused');
    return { subject: 'local:ehr-api', accountId: 'local:ehr-api' };
  }),
}) {
  const tokens = { verify: jest.fn().mockResolvedValue({ actor: doctor, claims: {} }),
    verifyCsrf: jest.fn((_claims, cookie: string | undefined, header: string | undefined) =>
      Boolean(cookie) && cookie === header) };
  const database = { query: jest.fn(async (_sql: string, parameters: unknown[]) =>
    ({ rows: [{ enabled: parameters[0] !== 'maintenance_mode' }] })) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { workloadAuth, guard: new SecurityGuard(new Reflector(), tokens as unknown as TokenService,
    audit as unknown as AuditService, database as unknown as DatabaseService,
    (workloadAuth ?? undefined) as WorkloadAuthService | undefined) };
}

const workload = { 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-token': 'valid-workload-token' };
const delegated = (extra: Record<string, string>) => request({ 'x-facility-id': facilityId, ...extra });

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: ORIGIN, AUTH_MODE: 'local', STORAGE_MODE: 'disabled',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});

describe('delegated browser requests through the Identity guard', () => {
  it.each(['GET', 'HEAD'])('allows a forwarded cookie with no Origin or CSRF when the authenticated workload reports %s',
    async (method) => {
      const { guard: subject, workloadAuth } = guard();
      await expect(subject.canActivate(context(delegated({ ...workload, 'x-hid-original-method': method }),
        authorizationCheck, IdentityController))).resolves.toBe(true);
      expect(workloadAuth?.authenticateService).toHaveBeenCalledWith('ehr-api', undefined, 'valid-workload-token');
    });

  it('still refuses a reported write without the CSRF token, and accepts it with Origin and CSRF', async () => {
    const { guard: subject } = guard();
    const write = { ...workload, 'x-hid-original-method': 'POST', origin: ORIGIN };
    expect((await refusal(subject.canActivate(context(delegated(write), authorizationCheck, IdentityController))))
      .code).toBe('CSRF_VALIDATION_FAILED');
    expect((await refusal(subject.canActivate(context(delegated({ ...workload, 'x-hid-original-method': 'POST' }),
      authorizationCheck, IdentityController)))).code).toBe('ORIGIN_DENIED');
    await expect(subject.canActivate(context(delegated({ ...write, 'x-csrf-token': 'csrf-token' }),
      authorizationCheck, IdentityController))).resolves.toBe(true);
  });

  it.each([
    ['a wrong workload token', { 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-token': 'forged-token' }],
    ['no workload credentials', {}],
    ['an unapproved caller name', { 'x-hid-internal-caller': 'browser', 'x-hid-service-token': 'valid-workload-token' }],
  ])('ignores a reported GET from %s and applies the browser-write check', async (_label, credentials) => {
    const { guard: subject } = guard();
    expect((await refusal(subject.canActivate(context(delegated({ ...credentials, 'x-hid-original-method': 'GET' }),
      authorizationCheck, IdentityController)))).code).toBe('ORIGIN_DENIED');
  });

  it.each([
    ['no reported method', {}],
    ['a lower-case method', { 'x-hid-original-method': 'get' }],
    ['an unknown method', { 'x-hid-original-method': 'PROPFIND' }],
  ])('applies the browser-write check for %s', async (_label, method) => {
    const { guard: subject } = guard();
    expect((await refusal(subject.canActivate(context(delegated({ ...workload, ...method }),
      authorizationCheck, IdentityController)))).code).toBe('ORIGIN_DENIED');
  });

  it('keeps the service-session mutation check: a reported GET does not relax POST /auth/service-session', async () => {
    const { guard: subject, workloadAuth } = guard();
    expect((await refusal(subject.canActivate(context(request({ ...workload, 'x-hid-original-method': 'GET' }),
      serviceSessionMutation, AuthController)))).code).toBe('ORIGIN_DENIED');
    expect(workloadAuth?.authenticateService).not.toHaveBeenCalled();
  });

  it('keeps the browser-write check when the guard has no workload authentication', async () => {
    const { guard: subject } = guard(null);
    expect((await refusal(subject.canActivate(context(delegated({ ...workload, 'x-hid-original-method': 'GET' }),
      authorizationCheck, IdentityController)))).code).toBe('ORIGIN_DENIED');
  });

  it('leaves bearer delegation unchanged', async () => {
    const { guard: subject, workloadAuth } = guard();
    await expect(subject.canActivate(context(request({ authorization: 'Bearer access-token', 'x-facility-id': facilityId }, {}),
      authorizationCheck, IdentityController))).resolves.toBe(true);
    expect(workloadAuth?.authenticateService).not.toHaveBeenCalled();
  });
});
