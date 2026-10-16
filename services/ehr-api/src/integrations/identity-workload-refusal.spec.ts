import { DomainProblem } from '../common/problem';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { IdentityApiService } from './identity-api.service';
import type { ServiceWorkloadIdentityService } from './service-workload-identity.service';

// A5, end to end over EHR's Identity client (a stubbed fetch): every EHR
// request authenticates through Identity, and every patient read or write,
// the patient's own records read included, is authorized there. Identity
// answers a refusal of EHR's own workload credential (a bad token, another
// caller subject, a missing caller) and its own inability to verify workloads
// with these codes. That is a fault between services, not a refusal of the
// user, so EHR answers 503 IDENTITY_SERVICE_AUTH_UNAVAILABLE on each of these
// calls: the browser does not refresh or end its session for it. A refusal of
// the user's own credential keeps Identity's status and code, so a 401 still
// reaches the browser only when the user's sign-in was refused.

const ENVIRONMENT = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
  CORS_ORIGINS: 'https://app.example', STORAGE_MODE: 'disabled', IDENTITY_API_URL: 'https://identity.example',
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret' };

const patientId = '50000000-0000-4000-8000-000000000001';
const facilityId = '10000000-0000-4000-8000-000000000002';
const workloadIdentity = { identityHeaders: async () => ({ 'x-hid-service-token': 'w'.repeat(32) }) };

/** A browser request as EHR's security guard receives or leaves it: cookie session, facility, actor. */
function browserRequest(method: string, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = Object.fromEntries(Object.entries({ cookie: 'hid_access=opaque; hid_access_csrf=csrf',
    'x-facility-id': facilityId, 'x-purpose-of-use': 'direct-care', ...headers })
    .map(([name, value]) => [name.toLowerCase(), value]));
  return { method, correlationId: 'correlation-workload-refusal-0001', facilityId,
    actor: { id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
      roles: ['doctor'], permissions: [], facilityIds: [facilityId], authenticationMethod: 'local',
      facility: { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001', organizationId: facilityId,
        name: 'Facility', roles: ['doctor'], permissions: [], isPrimary: true }, facilities: [] },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

const identity = () => new IdentityApiService(workloadIdentity as unknown as ServiceWorkloadIdentityService);
const calls = {
  'service-session GET': () => identity().authenticateRequest(browserRequest('GET')),
  'service-session POST': () => identity().authenticateRequest(browserRequest('POST',
    { origin: 'https://app.example', 'x-csrf-token': 'csrf' })),
  'patient authorization check': () => identity().authorize(patientId, 'read_records', 'direct-care',
    requireRequestContext(browserRequest('GET'))),
  'patient-self authorization': () => identity().authorizeSelf(browserRequest('GET')),
} as const;
const sentTo = {
  'service-session GET': ['/api/v1/auth/service-session', 'GET'],
  'service-session POST': ['/api/v1/auth/service-session', 'POST'],
  'patient authorization check': ['/api/v1/identity/service/authorization/check', 'POST'],
  'patient-self authorization': ['/api/v1/identity/service/patient-self-authorization', 'GET'],
} as const;
type Call = keyof typeof calls;
const everyCall = Object.keys(calls) as Call[];

const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  Object.assign(process.env, ENVIRONMENT);
  resetEnvironmentForTests();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});
afterEach(() => { global.fetch = originalFetch; resetEnvironmentForTests(); });

function answer(status: number, body: Record<string, unknown>) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/problem+json' } }));
}

async function refusal(operation: Promise<unknown>): Promise<DomainProblem> {
  const error = await operation.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

const workloadRefusals = [
  { status: 401, code: 'WORKLOAD_AUTHENTICATION_FAILED' },
  { status: 403, code: 'WORKLOAD_CALLER_DENIED' },
  { status: 503, code: 'WORKLOAD_IDENTITY_UNAVAILABLE' },
  { status: 401, code: 'WORKLOAD_AUTHENTICATION_REQUIRED' },
  { status: 403, code: 'WORKLOAD_AUTHENTICATION_REQUIRED' },
  { status: 401, code: 'INTERNAL_SERVICE_AUTH_REQUIRED' },
  { status: 401, code: 'INVALID_WORKLOAD_IDENTITY' },
];

describe('EHR answers an Identity refusal of the EHR workload as 503', () => {
  it.each(everyCall.flatMap((call) => workloadRefusals.map((refused) => ({ call, ...refused }))))(
    '$call: $status $code becomes 503 IDENTITY_SERVICE_AUTH_UNAVAILABLE', async ({ call, status, code }) => {
      answer(status, { status, code, detail: 'Synthetic workload refusal' });
      const problem = await refusal(calls[call]());
      expect([problem.getStatus(), problem.code]).toEqual([503, 'IDENTITY_SERVICE_AUTH_UNAVAILABLE']);
      // No Idempotency-Key is sent, so the client does not retry: Identity was asked once.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(`https://identity.example${sentTo[call][0]}`,
        expect.objectContaining({ method: sentTo[call][1] }));
    });

  const passedThrough = [
    // The user's own access token has expired or was revoked.
    { status: 401, code: 'AUTHENTICATION_REQUIRED' },
    { status: 403, code: 'FACILITY_ACCESS_DENIED' },
    { status: 403, code: 'PERMISSION_DENIED' },
    { status: 403, code: 'PATIENT_SCOPE_DENIED' },
    { status: 403, code: 'ORIGIN_DENIED' },
    { status: 403, code: 'CSRF_VALIDATION_FAILED' },
    { status: 403, code: 'STAFF_MFA_REQUIRED' },
    { status: 503, code: 'PLATFORM_MAINTENANCE' },
    { status: 503, code: 'PLATFORM_CONTROL_UNAVAILABLE' },
    // Only a 401, 403 or 503 is a workload refusal; another status keeps its code.
    { status: 400, code: 'INVALID_WORKLOAD_IDENTITY' },
  ];
  it.each(everyCall.flatMap((call) => passedThrough.map((refused) => ({ call, ...refused }))))(
    '$call: $status $code keeps its status and code', async ({ call, status, code }) => {
      answer(status, { status, code, detail: 'Synthetic refusal' });
      const problem = await refusal(calls[call]());
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
    });

  it.each(everyCall)('%s: a 401 without a code keeps the IDENTITY_SERVICE_ERROR fallback', async (call) => {
    answer(401, { detail: 'Synthetic refusal without a code' });
    const problem = await refusal(calls[call]());
    expect([problem.getStatus(), problem.code]).toEqual([401, 'IDENTITY_SERVICE_ERROR']);
  });

  it('keeps EHR\'s own workload token-source fault as 503 IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE', async () => {
    const unavailable = { identityHeaders: async () => {
      throw new DomainProblem(503, 'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE', 'Identity workload token source is not configured');
    } };
    const problem = await refusal(new IdentityApiService(unavailable as unknown as ServiceWorkloadIdentityService)
      .authenticateRequest(browserRequest('GET')));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
