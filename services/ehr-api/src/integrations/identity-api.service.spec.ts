import { IdentityApiProblem } from '@hid/api-client';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { IdentityApiService } from './identity-api.service';
import type { ServiceWorkloadIdentityService } from './service-workload-identity.service';

// A5: Identity's refusal of EHR's own workload credential (a JWKS outage, an
// expired workload token, a wrong caller) reached the browser as the 401 or
// 403 Identity answered, and Health-id read the 401 as "signed out". It is a
// fault between services: EHR answers 503 IDENTITY_SERVICE_AUTH_UNAVAILABLE.
// A refusal of the user's own session keeps its status and code.

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
    DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled',
    IDENTITY_API_URL: 'http://127.0.0.1:3001' });
  resetEnvironmentForTests();
});
afterEach(() => resetEnvironmentForTests());

function serviceRefusing(refusal: unknown) {
  const service = new IdentityApiService({} as ServiceWorkloadIdentityService);
  const client = { authenticateActor: jest.fn().mockRejectedValue(refusal),
    authorizePatient: jest.fn().mockRejectedValue(refusal) };
  Object.assign(service as unknown as { client: unknown }, { client });
  return service;
}

const browserRequest = { correlationId: 'identity-translate-test', method: 'GET',
  header: (name: string) => (name === 'cookie' ? 'hid_access=opaque' : undefined) } as unknown as HidRequest;

async function problemOf(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

describe('IdentityApiService: a refusal of the EHR workload is a fault between services (A5)', () => {
  it.each([
    [401, 'WORKLOAD_AUTHENTICATION_FAILED'],
    [403, 'WORKLOAD_CALLER_DENIED'],
    [503, 'WORKLOAD_IDENTITY_UNAVAILABLE'],
    [401, 'WORKLOAD_AUTHENTICATION_REQUIRED'],
    [403, 'WORKLOAD_AUTHENTICATION_REQUIRED'],
    [401, 'INVALID_WORKLOAD_IDENTITY'],
    [401, 'INTERNAL_SERVICE_AUTH_REQUIRED'],
  ])('answers Identity %s %s as 503 IDENTITY_SERVICE_AUTH_UNAVAILABLE', async (status, code) => {
    const problem = await problemOf(serviceRefusing(new IdentityApiProblem(status, { code, detail: 'refused' }))
      .authenticateRequest(browserRequest));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'IDENTITY_SERVICE_AUTH_UNAVAILABLE']);
  });

  it.each([
    [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'STAFF_MFA_REQUIRED'],
    [403, 'PATIENT_SESSION_REQUIRED'],
    [403, 'ORIGIN_DENIED'],
    [503, 'PLATFORM_MAINTENANCE'],
  ])('keeps a refusal of the user\'s request, Identity %s %s, as it is', async (status, code) => {
    const problem = await problemOf(serviceRefusing(new IdentityApiProblem(status, { code, detail: 'refused' }))
      .authenticateRequest(browserRequest));
    expect([problem.getStatus(), problem.code]).toEqual([status, code]);
  });

  it('maps the same workload refusal on the patient authorization check', async () => {
    const problem = await problemOf(serviceRefusing(new IdentityApiProblem(401, { code: 'WORKLOAD_AUTHENTICATION_FAILED' }))
      .authorize('50000000-0000-4000-8000-000000000001', 'read_records', 'direct-care', {
        correlationId: 'identity-translate-test', facilityId: '10000000-0000-4000-8000-000000000001',
      } as never));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'IDENTITY_SERVICE_AUTH_UNAVAILABLE']);
  });
});
