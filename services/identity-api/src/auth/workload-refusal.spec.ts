jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { IdentityController } from '../identity/identity.controller';
import type { IdentityService } from '../identity/identity.service';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';
import { WorkloadAuthService } from './workload-auth.service';

// A5: workload (service-to-service) refusals used the exception types and
// default codes of user refusals: a JWKS outage, an expired workload token or
// a wrong caller subject answered 401 AUTHENTICATION_REQUIRED or 403
// ACCESS_DENIED, which EHR relayed and the browser read as "signed out".
// A18: the patient authorization check evaluated write_records for a request
// the guard admitted as a reported browser read (no Origin or CSRF check).

const env = {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', DATABASE_SSL: 'false',
  CORS_ORIGINS: 'https://staging.healthidentitydirectory.com', AUTH_MODE: 'local', STORAGE_MODE: 'disabled',
  AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
  AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters',
  IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', WORKLOAD_ISSUER_URL: 'https://issuer.test',
  WORKLOAD_JWKS_URL: 'https://issuer.test/jwks', WORKLOAD_AUDIENCE: 'hid-identity-api',
  IDENTITY_EHR_CALLER_SUBJECT: 'workload:ehr-api',
};

const joseError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });

async function problemOf(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

beforeEach(() => {
  Object.assign(process.env, env);
  resetEnvironmentForTests();
  jest.mocked(createRemoteJWKSet).mockReturnValue(jest.fn() as never);
  jest.mocked(jwtVerify).mockReset();
});
afterEach(() => resetEnvironmentForTests());

describe('WorkloadAuthService refusal classes (A5)', () => {
  const service = () => new WorkloadAuthService({} as never);

  it.each([
    ['a JWKS fetch timeout', joseError('ERR_JWKS_TIMEOUT')],
    ['an unreachable JWKS endpoint', new TypeError('fetch failed')],
    ['a JWKS endpoint answering other than 200', joseError('ERR_JOSE_GENERIC')],
    ['an unusable JWKS document', joseError('ERR_JWKS_INVALID')],
  ])('answers %s with 503 WORKLOAD_IDENTITY_UNAVAILABLE', async (_label, fault) => {
    jest.mocked(jwtVerify).mockRejectedValue(fault);
    const problem = await problemOf(service().authenticateService('ehr-api', 'Bearer signed-token', undefined));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'WORKLOAD_IDENTITY_UNAVAILABLE']);
  });

  it.each([
    ['a bad signature', joseError('ERR_JWS_SIGNATURE_VERIFICATION_FAILED')],
    ['an expired workload token', joseError('ERR_JWT_EXPIRED')],
    ['a key the issuer does not publish', joseError('ERR_JWKS_NO_MATCHING_KEY')],
    ['a claim mismatch', joseError('ERR_JWT_CLAIM_VALIDATION_FAILED')],
  ])('answers %s with 401 WORKLOAD_AUTHENTICATION_FAILED', async (_label, fault) => {
    jest.mocked(jwtVerify).mockRejectedValue(fault);
    const problem = await problemOf(service().authenticateService('ehr-api', 'Bearer signed-token', undefined));
    expect([problem.getStatus(), problem.code]).toEqual([401, 'WORKLOAD_AUTHENTICATION_FAILED']);
  });

  it('answers a missing workload bearer and an unapproved caller with 401 WORKLOAD_AUTHENTICATION_FAILED', async () => {
    for (const attempt of [() => service().authenticateService('ehr-api', undefined, undefined),
      () => service().authenticateService('browser', 'Bearer signed-token', undefined)]) {
      const problem = await problemOf(attempt());
      expect([problem.getStatus(), problem.code]).toEqual([401, 'WORKLOAD_AUTHENTICATION_FAILED']);
    }
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('answers a valid token of another workload with 403 WORKLOAD_CALLER_DENIED', async () => {
    jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'workload:lab-api', token_use: 'workload' } } as never);
    const problem = await problemOf(service().authenticateService('ehr-api', 'Bearer signed-token', undefined));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'WORKLOAD_CALLER_DENIED']);
  });

  it('answers a missing issuer configuration with 503 WORKLOAD_IDENTITY_UNAVAILABLE', async () => {
    delete process.env.WORKLOAD_JWKS_URL;
    resetEnvironmentForTests();
    const problem = await problemOf(service().authenticateService('ehr-api', 'Bearer signed-token', undefined));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'WORKLOAD_IDENTITY_UNAVAILABLE']);
  });

  it('answers a refused document scanner token (the EHR caller\'s credential) with its own 401 code', async () => {
    jest.mocked(jwtVerify).mockRejectedValue(joseError('ERR_JWS_SIGNATURE_VERIFICATION_FAILED'));
    const problem = await problemOf(service().authenticateScanner('Bearer scanner-token'));
    expect([problem.getStatus(), problem.code]).toEqual([401, 'DOCUMENT_SCANNER_AUTHENTICATION_FAILED']);
  });

  it('answers a wrong local development secret with 401 WORKLOAD_AUTHENTICATION_FAILED', async () => {
    Object.assign(process.env, { IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
      IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: ['ehr', 'independent', 'local', 'value', '1234'].join('-') });
    resetEnvironmentForTests();
    const problem = await problemOf(service().authenticateService('ehr-api', undefined, 'wrong-local-value'));
    expect([problem.getStatus(), problem.code]).toEqual([401, 'WORKLOAD_AUTHENTICATION_FAILED']);
  });
});

const facilityId = '10000000-0000-4000-8000-00000000000a';
const doctor = {
  id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001', kind: 'staff',
  sessionId: '90000000-0000-4000-8000-000000000001', roles: [], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: [facilityId], authenticationMethod: 'local',
  facilities: [{ id: facilityId, membershipId: '40000000-0000-4000-8000-00000000000a',
    organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A', roles: ['doctor'],
    permissions: ['identity.authorization.check'], isPrimary: true }],
} as unknown as ActorContext;

function delegatedRequest(headers: Record<string, string>): HidRequest {
  const lower = Object.fromEntries(Object.entries({ 'x-facility-id': facilityId, ...headers })
    .map(([name, value]) => [name.toLowerCase(), value]));
  return { method: 'POST', correlationId: 'workload-refusal-test', ip: '127.0.0.1',
    route: { path: '/identity/service/authorization/check' },
    cookies: { hid_access: 'access-token', hid_access_csrf: 'csrf-token' },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function delegatedContext(request: HidRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => IdentityController.prototype.authorizeService, getClass: () => IdentityController,
  } as unknown as ExecutionContext;
}

function guardWithWorkload(refusal: unknown) {
  const tokens = { verify: jest.fn().mockResolvedValue({ actor: doctor, claims: {}, mfaAssured: true }),
    verifyCsrf: jest.fn(() => false) };
  const database = { query: jest.fn(async (_sql: string, parameters: unknown[]) =>
    ({ rows: [{ enabled: parameters[0] !== 'maintenance_mode' }] })) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const workloadAuth = { authenticateService: jest.fn().mockRejectedValue(refusal) };
  return new SecurityGuard(new Reflector(), tokens as unknown as TokenService, audit as unknown as AuditService,
    database as unknown as DatabaseService, workloadAuth as unknown as WorkloadAuthService);
}

describe('SecurityGuard delegated browser read when the workload cannot be authenticated (A5)', () => {
  const read = { 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-authorization': 'Bearer workload',
    'x-hid-original-method': 'GET' };

  it('answers an unavailable workload issuer with 503, not the browser-write 403 ORIGIN_DENIED', async () => {
    const guard = guardWithWorkload(new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
      'Workload identity verification is temporarily unavailable'));
    const problem = await problemOf(guard.canActivate(delegatedContext(delegatedRequest(read))));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'WORKLOAD_IDENTITY_UNAVAILABLE']);
  });

  it('keeps the browser-write check for a refused workload token (fails closed)', async () => {
    const guard = guardWithWorkload(new DomainProblem(401, 'WORKLOAD_AUTHENTICATION_FAILED',
      'Workload authentication failed'));
    const problem = await problemOf(guard.canActivate(delegatedContext(delegatedRequest(read))));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'ORIGIN_DENIED']);
  });
});

describe('IdentityController.authorizeService on a reported browser read (A18)', () => {
  function controller() {
    const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true }) };
    const workloadAuth = { authenticateService: jest.fn().mockResolvedValue({ subject: 'workload:ehr-api',
      accountId: 'workload:ehr-api' }) };
    return { identity, subject: new IdentityController(identity as unknown as IdentityService,
      workloadAuth as unknown as WorkloadAuthService) };
  }
  function admitted(delegatedBrowserMethod?: string): HidRequest {
    const request = delegatedRequest({ 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-token': 'local' });
    Object.assign(request, { actor: doctor, facilityId, delegatedBrowserMethod });
    return request;
  }
  const input = (scope: 'read_records' | 'write_records') => ({ patientId: '50000000-0000-4000-8000-000000000001',
    scope, purpose: 'direct-care' as const });

  it('refuses write_records when the browser-write check was skipped for a reported read', async () => {
    const { identity, subject } = controller();
    const problem = await problemOf(subject.authorizeService(input('write_records'), admitted('GET')));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(identity.authorize).not.toHaveBeenCalled();
  });

  it('authorizes read_records for a delegated read', async () => {
    const { identity, subject } = controller();
    await expect(subject.authorizeService(input('read_records'), admitted('GET'))).resolves.toEqual({ allowed: true });
    expect(identity.authorize).toHaveBeenCalledTimes(1);
  });

  it('authorizes write_records when the guard applied the browser-write check', async () => {
    const { identity, subject } = controller();
    await expect(subject.authorizeService(input('write_records'), admitted(undefined))).resolves.toEqual({ allowed: true });
    expect(identity.authorize).toHaveBeenCalledTimes(1);
  });
});
