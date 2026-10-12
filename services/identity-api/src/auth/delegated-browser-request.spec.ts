jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { ExecutionContext } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Reflector } from '@nestjs/core';
import type { AuditService } from '../audit/audit.service';
import { DELEGATED_BROWSER_REQUEST } from '../common/decorators';
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
    if (!(caller === 'ehr-api' && token === 'valid-workload-token')
      && !(caller === 'outreach-api' && token === 'valid-outreach-token')) throw new Error('workload refused');
    return { subject: `local:${caller}`, accountId: `local:${caller}` };
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
  it.each(['GET', 'HEAD', 'OPTIONS'])('allows a forwarded cookie with no Origin or CSRF when the authenticated workload reports %s',
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

  it('marks only the patient authorization check and the Outreach authorization as delegated browser requests', () => {
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
    const marked = files(join(__dirname, '..')).filter((file) => !file.endsWith('.spec.ts'))
      .flatMap((file) => (readFileSync(file, 'utf8').match(/@DelegatedBrowserRequest\(\)/g) ?? []).map(() => file));
    expect(marked.map((file) => file.slice(file.indexOf('src/'))))
      .toEqual(['src/identity/identity.controller.ts', 'src/identity/identity.controller.ts']);
    const handlers = Object.getOwnPropertyNames(IdentityController.prototype).filter((name) =>
      Reflect.getMetadata(DELEGATED_BROWSER_REQUEST, (IdentityController.prototype as unknown as Record<string, object>)[name] as object) === true);
    expect(handlers.sort()).toEqual(['authorizeOutreach', 'authorizeService']);
  });

  it('leaves bearer delegation unchanged', async () => {
    const { guard: subject, workloadAuth } = guard();
    await expect(subject.canActivate(context(request({ authorization: 'Bearer access-token', 'x-facility-id': facilityId }, {}),
      authorizationCheck, IdentityController))).resolves.toBe(true);
    expect(workloadAuth?.authenticateService).not.toHaveBeenCalled();
  });
});

// Outreach authorizes each browser request with POST /identity/outreach/authorize,
// forwarding the cookie. A same-origin read carries no Origin or CSRF token.
describe('delegated Outreach reads through the Identity guard', () => {
  const outreachAuthorization = IdentityController.prototype.authorizeOutreach;
  const outreach = { 'x-hid-internal-caller': 'outreach-api', 'x-hid-service-token': 'valid-outreach-token' };
  const outreachRequest = (extra: Record<string, string>) => {
    const target = delegated(extra);
    Object.assign(target, { route: { path: '/identity/outreach/authorize' } });
    return target;
  };

  it.each(['GET', 'HEAD'])('allows a forwarded cookie with no Origin or CSRF when Outreach reports %s, and records the method',
    async (method) => {
      const { guard: subject, workloadAuth } = guard();
      const target = outreachRequest({ ...outreach, 'x-hid-original-method': method });
      await expect(subject.canActivate(context(target, outreachAuthorization, IdentityController))).resolves.toBe(true);
      expect(workloadAuth?.authenticateService).toHaveBeenCalledWith('outreach-api', undefined, 'valid-outreach-token');
      expect(target.delegatedBrowserMethod).toBe(method);
    });

  it.each([
    ['a wrong workload token', { 'x-hid-internal-caller': 'outreach-api', 'x-hid-service-token': 'forged-token' }],
    ['no workload credentials', {}],
  ])('ignores a reported GET from %s and applies the browser-write check', async (_label, credentials) => {
    const { guard: subject } = guard();
    expect((await refusal(subject.canActivate(context(outreachRequest({ ...credentials, 'x-hid-original-method': 'GET' }),
      outreachAuthorization, IdentityController)))).code).toBe('ORIGIN_DENIED');
  });

  it('applies the browser-write check to a reported write and to an unreported method, and records no delegation', async () => {
    const { guard: subject } = guard();
    expect((await refusal(subject.canActivate(context(outreachRequest({ ...outreach }), outreachAuthorization,
      IdentityController)))).code).toBe('ORIGIN_DENIED');
    expect((await refusal(subject.canActivate(context(outreachRequest({ ...outreach, 'x-hid-original-method': 'POST',
      origin: ORIGIN }), outreachAuthorization, IdentityController)))).code).toBe('CSRF_VALIDATION_FAILED');
    const write = outreachRequest({ ...outreach, 'x-hid-original-method': 'POST', origin: ORIGIN, 'x-csrf-token': 'csrf-token' });
    await expect(subject.canActivate(context(write, outreachAuthorization, IdentityController))).resolves.toBe(true);
    expect(write.delegatedBrowserMethod).toBeUndefined();
  });
});

describe('IdentityController.authorizeOutreach', () => {
  const outreachActor = { ...doctor, permissions: ['outreach.registration.read', 'outreach.registration.write',
    'outreach.campaign.read', 'outreach.campaign.write'] } as ActorContext;
  function controller() {
    const workloadAuth = { authenticateOutreach: jest.fn().mockResolvedValue({ subject: 'local:outreach-api' }) };
    return { workloadAuth, subject: new IdentityController({} as never, workloadAuth as unknown as WorkloadAuthService) };
  }
  function handlerRequest(delegatedBrowserMethod?: string): HidRequest {
    return { correlationId: 'outreach-authorize-test', actor: outreachActor, facilityId,
      ...(delegatedBrowserMethod ? { delegatedBrowserMethod } : {}),
      header: (name: string) => ({ 'x-hid-internal-caller': 'outreach-api' } as Record<string, string>)[name.toLowerCase()],
    } as unknown as HidRequest;
  }

  it('authorizes a read permission for a delegated read', async () => {
    const { subject } = controller();
    await expect(subject.authorizeOutreach({ permission: 'outreach.registration.read' }, handlerRequest('GET')))
      .resolves.toMatchObject({ authorized: true });
    await expect(subject.authorizeOutreach({ permission: 'outreach.campaign.read' }, handlerRequest('HEAD')))
      .resolves.toMatchObject({ authorized: true });
  });

  it('refuses a write permission when the browser-write check was skipped for a reported read', async () => {
    const { subject } = controller();
    for (const permission of ['outreach.registration.write', 'outreach.campaign.write'] as const) {
      expect((await refusal(subject.authorizeOutreach({ permission }, handlerRequest('GET')))).code)
        .toBe('CSRF_VALIDATION_FAILED');
    }
  });

  it('authorizes a write permission when the request passed the browser-write check (or used a bearer token)', async () => {
    const { subject } = controller();
    await expect(subject.authorizeOutreach({ permission: 'outreach.campaign.write' }, handlerRequest()))
      .resolves.toMatchObject({ authorized: true });
  });
});
