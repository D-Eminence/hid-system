import type { LabWorkloadIdentityService } from '../auth/lab-workload-identity.service';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { RemoteIdentityProvider } from './remote-identity.provider';

const ENVIRONMENT = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', DATABASE_SSL: 'false',
  CORS_ORIGINS: 'https://app.example', IDENTITY_API_URL: 'https://identity.example',
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', LAB_INTERNAL_SERVICE_TOKEN: 'l'.repeat(32) };

// Lab authorizes each patient read by POSTing to Identity with the browser's cookie.
// Identity applies its browser-write Origin and CSRF check only when the browser
// request was a write, so the browser method must reach it.

const patientId = '50000000-0000-4000-8000-000000000001';
const facilityId = '10000000-0000-4000-8000-000000000002';
const decision = { allowed: true, patientId, facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
  scope: 'read_records', purpose: 'direct-care', breakGlass: false };
const workloadIdentity = { identityHeaders: async () => ({ 'x-hid-service-token': 'w'.repeat(32) }) };

/** A browser request as the service's security guard leaves it: cookie session, facility, actor. */
function browserRequest(method: string, headers: Record<string, string>) {
  const lower: Record<string, string> = Object.fromEntries(Object.entries({ cookie: 'hid_access=opaque; hid_access_csrf=csrf',
    'x-purpose-of-use': 'direct-care', ...headers }).map(([name, value]) => [name.toLowerCase(), value]));
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

const authorize = (request: ReturnType<typeof browserRequest>) => new RemoteIdentityProvider(
  workloadIdentity as unknown as LabWorkloadIdentityService).authorize({ patientId, scope: 'read_records',
  purpose: 'direct-care', context: requireRequestContext(request as unknown as HidRequest) });

describe('Lab forwards the browser request method to Identity', () => {
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

describe('ORD-3 progress: the clinician\'s read reaches Identity as a GET', () => {
  // The internal ehr-api call is a POST with the clinician's cookie and no Origin or CSRF token
  // (the website sends none on its GET to ehr-api). Reported as POST, Identity would apply the
  // browser-write check and answer 403 CSRF_VALIDATION_FAILED, so ownProgress would always be unknown.
  it('reports GET, with the cookie and no Origin or CSRF token, for a cookie-only internal POST', async () => {
    const { LabWorkItemProgressService } = await import('../lab/work-item-progress.service');
    const { IdentityService } = await import('./identity.service');
    const query = jest.fn(async () => ({ rows: [] }));
    const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
      operation({ query })) };
    const audit = { record: jest.fn(), recordWithClient: jest.fn() };
    const provider = new RemoteIdentityProvider(workloadIdentity as unknown as LabWorkloadIdentityService);
    const identity = new IdentityService(provider, audit as never);
    const service = new LabWorkItemProgressService(database as never, identity, audit as never);
    const request = browserRequest('POST', { 'x-hid-internal-caller': 'ehr-api' });
    const context = requireRequestContext(request as unknown as HidRequest);
    expect(context.requestMethod).toBe('POST');
    const answer = await service.read(context, { patientId,
      sourceEhrOrderIds: ['60000000-0000-4000-8000-000000000001'] });
    expect(answer.items[0]?.status).toBe('not_received');
    const headers = sentHeaders(fetchMock);
    expect(headers).toMatchObject({ 'x-hid-original-method': 'GET', cookie: 'hid_access=opaque; hid_access_csrf=csrf' });
    expect(headers).not.toHaveProperty('origin');
    expect(headers).not.toHaveProperty('x-csrf-token');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ patientId, scope: 'read_records' });
  });

  it('reports GET for each patient of the batch form (decision 4), with the cookie and no Origin or CSRF token',
    async () => {
      const { LabWorkItemProgressService } = await import('../lab/work-item-progress.service');
      const { IdentityService } = await import('./identity.service');
      // Identity answers each check for the patient it was asked about.
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => new Response(JSON.stringify({
        ...decision, patientId: JSON.parse(String(init.body)).patientId }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
      const query = jest.fn(async () => ({ rows: [] }));
      const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
        operation({ query })) };
      const audit = { record: jest.fn(), recordWithClient: jest.fn() };
      const provider = new RemoteIdentityProvider(workloadIdentity as unknown as LabWorkloadIdentityService);
      const service = new LabWorkItemProgressService(database as never, new IdentityService(provider, audit as never),
        audit as never);
      const request = browserRequest('POST', { 'x-hid-internal-caller': 'ehr-api' });
      const context = requireRequestContext(request as unknown as HidRequest);
      const otherPatientId = '50000000-0000-4000-8000-000000000002';
      const answer = await service.readBatch(context, { patients: [
        { patientId, sourceEhrOrderIds: ['60000000-0000-4000-8000-000000000001'] },
        { patientId: otherPatientId, sourceEhrOrderIds: ['60000000-0000-4000-8000-000000000002'] }] });
      expect(answer.patients.map((entry) => entry.outcome)).toEqual(['answered', 'answered']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const asked: string[] = [];
      for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
        expect(url).toBe('https://identity.example/api/v1/identity/service/authorization/check');
        const headers = init.headers as Record<string, string>;
        expect(headers).toMatchObject({ 'x-hid-original-method': 'GET',
          cookie: 'hid_access=opaque; hid_access_csrf=csrf' });
        expect(headers).not.toHaveProperty('origin');
        expect(headers).not.toHaveProperty('x-csrf-token');
        const body = JSON.parse(String(init.body)) as { patientId: string; scope: string };
        expect(body.scope).toBe('read_records');
        asked.push(body.patientId);
      }
      expect(asked).toEqual([patientId, otherPatientId]);
    });

  // The batch's budget must abort the fetch to Identity itself, not only stop waiting for it; otherwise each hung
  // check keeps its connection to Identity open, and its audit row waits, until the Identity client's 5 second limit.
  it('aborts each batch check\'s fetch to Identity when the batch\'s budget is up, and audits each as failed',
    async () => {
      const { LabWorkItemProgressService } = await import('../lab/work-item-progress.service');
      const { IdentityService } = await import('./identity.service');
      // Identity never answers; each fetch rejects only once its own signal aborts, as fetch does.
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted',
          'AbortError')), { once: true });
      }));
      const database = { withTransaction: jest.fn() };
      const audit = { record: jest.fn(), recordWithClient: jest.fn() };
      const provider = new RemoteIdentityProvider(workloadIdentity as unknown as LabWorkloadIdentityService);
      const service = new LabWorkItemProgressService(database as never, new IdentityService(provider, audit as never),
        audit as never);
      service.batchCheckBudgetMs = 20;
      const request = browserRequest('POST', { 'x-hid-internal-caller': 'ehr-api' });
      const context = requireRequestContext(request as unknown as HidRequest);
      const otherPatientId = '50000000-0000-4000-8000-000000000002';
      const started = Date.now();
      const answer = await service.readBatch(context, { patients: [
        { patientId, sourceEhrOrderIds: ['60000000-0000-4000-8000-000000000001'] },
        { patientId: otherPatientId, sourceEhrOrderIds: ['60000000-0000-4000-8000-000000000002'] }] });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(answer.patients).toEqual([
        { patientId, outcome: 'unavailable', code: 'PROGRESS_CHECK_TIME_LIMIT' },
        { patientId: otherPatientId, outcome: 'unavailable', code: 'PROGRESS_CHECK_TIME_LIMIT' }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
        expect(init.signal?.aborted).toBe(true);
      }
      // The answer does not wait for the aborted checks; each writes its row as its aborted fetch ends.
      for (let turn = 0; turn < 20 && audit.record.mock.calls.length < 2; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect((audit.record.mock.calls as Array<[{ action: string; patientId: string; outcome: string }]>)
        .map(([event]) => [event.action, event.patientId, event.outcome])).toEqual([
        ['identity.authorization.check', patientId, 'failure'],
        ['identity.authorization.check', otherPatientId, 'failure']]);
      expect(database.withTransaction).not.toHaveBeenCalled();
    });
});
