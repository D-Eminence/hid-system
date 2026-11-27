import type { LabAcceptEhrOrderInput } from '@hid/api-client';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { LabApiService } from './lab-api.service';
import type { ServiceWorkloadIdentityService } from './service-workload-identity.service';

/*
 * ORD-6 (0158): a group's send gets an AbortSignal for the time left before
 * its deadline. LabApiService passes it to Lab's client; a send cut off is
 * 503 LAB_SERVICE_UNAVAILABLE, as an unreachable Lab is, and is not retried.
 * Fictional data only.
 */
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const context = { correlationId: 'correlation-123456', facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174004',
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { accountId: '123e4567-e89b-42d3-a456-426614174003' } } as
  unknown as DataAccessContext;
const order: LabAcceptEhrOrderInput = { sourceEhrOrderId: '223e4567-e89b-42d3-a456-000000000001', sourceEhrOrderVersion: 1,
  sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', patientId: '123e4567-e89b-42d3-a456-426614174001',
  orderingFacilityId: facilityId, testCodeSystem: 'LOINC', testCode: '58410-2', testName: 'Full blood count',
  priority: 'routine', requestedBy: '123e4567-e89b-42d3-a456-426614174003', requestedAt: '2026-12-01T09:00:00.123456Z' };

describe('LabApiService.acceptEhrOrder with a deadline (ORD-6)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { DATABASE_URL: 'postgresql://ehr:test@127.0.0.1/hid', CORS_ORIGINS: 'http://localhost',
      STORAGE_MODE: 'disabled', LAB_API_URL: 'https://lab.example.test', LAB_SERVICE_IDENTITY_MODE: 'local-secret',
      LAB_INTERNAL_SERVICE_TOKEN: 'local-lab-service-token-0123456789abcdef' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
    jest.restoreAllMocks();
  });
  const labApi = () => new LabApiService({} as ServiceWorkloadIdentityService);

  it('passes the signal to Lab: a send cut off is 503 LAB_SERVICE_UNAVAILABLE, with no second attempt', async () => {
    // Lab does not answer: the request ends only when its signal aborts.
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();
    const sent = labApi().acceptEhrOrder(context, order, 'ehr-order:223e4567-e89b-42d3-a456-000000000001:1',
      controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const refusal = await sent.catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DomainProblem);
    expect(refusal).toMatchObject({ status: 503, code: 'LAB_SERVICE_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://lab.example.test/api/v1/lab/work-items/accept-ehr-order');
    // The order is the single create's: no group goes to Lab (0158's validator copies it).
    expect(Object.keys(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)))).not.toContain('requestGroupId');
  });

  it('without a signal it is as before: one retry of a 503, then Lab\'s own problem', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ code: 'LAB_BUSY', detail: 'Lab is busy' }), { status: 503, headers: { 'content-type': 'application/json' } }));
    await expect(labApi().acceptEhrOrder(context, order, 'ehr-order:223e4567-e89b-42d3-a456-000000000001:1'))
      .rejects.toMatchObject({ status: 503, code: 'LAB_BUSY' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
