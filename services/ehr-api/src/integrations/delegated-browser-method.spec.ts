import { requireRequestContext, type HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { IdentityApiService } from './identity-api.service';
import type { ServiceWorkloadIdentityService } from './service-workload-identity.service';

const ENVIRONMENT = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
  CORS_ORIGINS: 'https://app.example', STORAGE_MODE: 'disabled', IDENTITY_API_URL: 'https://identity.example',
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret' };

// EHR authorizes each patient read by POSTing to Identity with the browser's cookie.
// Identity applies its browser-write Origin and CSRF check only when the browser
// request was a write, so the browser method must reach it.

const patientId = '50000000-0000-4000-8000-000000000001';
const facilityId = '10000000-0000-4000-8000-000000000002';
const decision = { allowed: true, patientId, facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
  scope: 'read_records', purpose: 'emergency', breakGlass: false };
const workloadIdentity = { identityHeaders: async () => ({ 'x-hid-service-token': 'w'.repeat(32) }) };

/** A browser request as the service's security guard leaves it: cookie session, facility, actor. */
function browserRequest(method: string, headers: Record<string, string>) {
  const lower: Record<string, string> = Object.fromEntries(Object.entries({ cookie: 'hid_access=opaque; hid_access_csrf=csrf',
    'x-purpose-of-use': 'emergency', ...headers }).map(([name, value]) => [name.toLowerCase(), value]));
  return { method, correlationId: 'correlation-delegated-method-0001', facilityId,
    actor: { id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
      roles: ['doctor'], permissions: [], facilityIds: [facilityId], authenticationMethod: 'local',
      facility: { id: facilityId, membershipId: decision.membershipId, organizationId: facilityId, name: 'Facility',
        roles: ['doctor'], permissions: [], isPrimary: true }, facilities: [] },
    header: (name: string) => lower[name.toLowerCase()] };
}

function sentHeaders(fetchMock: jest.Mock): Record<string, string> {
  expect(fetchMock).toHaveBeenCalledWith('https://identity.example/api/v1/identity/service/authorization/check',
    expect.objectContaining({ method: 'POST' }));
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  Object.assign(process.env, ENVIRONMENT);
  resetEnvironmentForTests();
  fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(decision),
    { status: 200, headers: { 'content-type': 'application/json' } }));
  global.fetch = fetchMock;
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

// On this branch a direct-care record read goes to Identity's workload-authenticated
// record-read-authorization route instead (IdentityApiService.authorize), so the
// delegated check is exercised with an emergency read.
const authorize = (request: ReturnType<typeof browserRequest>) => new IdentityApiService(
  workloadIdentity as unknown as ServiceWorkloadIdentityService).authorize(patientId, 'read_records', 'emergency',
  requireRequestContext(request as unknown as HidRequest));

describe('EHR forwards the browser request method to Identity', () => {
  it('reports a same-origin browser GET as GET, with the cookie and no Origin or CSRF token', async () => {
    await authorize(browserRequest('GET', {}));
    const headers = sentHeaders(fetchMock);
    expect(headers).toMatchObject({ 'x-hid-original-method': 'GET', cookie: 'hid_access=opaque; hid_access_csrf=csrf',
      'x-hid-internal-caller': expect.any(String), 'x-hid-service-token': 'w'.repeat(32) });
    expect(headers).not.toHaveProperty('origin');
    expect(headers).not.toHaveProperty('x-csrf-token');
  });

  it('reports a browser write as its method, with the Origin and CSRF token it carried', async () => {
    await authorize(browserRequest('POST', { origin: 'https://app.example', 'x-csrf-token': 'csrf' }));
    expect(sentHeaders(fetchMock)).toMatchObject({ 'x-hid-original-method': 'POST', origin: 'https://app.example',
      'x-csrf-token': 'csrf' });
  });
});
