import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { LabRequestsController } from '../ehr/lab-requests/lab-requests.controller';
import { PrescriptionsController } from '../ehr/prescriptions/prescriptions.controller';
import type { HidRequest } from '../common/request-context';
import { LAB_PROGRESS_NOT_RECEIVED, LAB_PROGRESS_UNKNOWN, OWN_PROGRESS_BATCH, OWN_PROGRESS_TIMEOUT_MS,
  PHARMACY_PROGRESS_NOT_RECEIVED, PHARMACY_PROGRESS_UNKNOWN, WorkItemProgressService } from './work-item-progress.service';

// Fictional ids only.
const patientId = '9c3e2f40-0000-4000-8000-000000000001';
const facilityId = '9c3e2f40-0000-4000-8000-000000000002';
const encounterId = '9c3e2f40-0000-4000-8000-000000000003';
const rx = (n: number) => `9c3e2f40-0000-4000-8000-${String(n).padStart(12, '0')}`;
const serviceToken = 's'.repeat(32);

const context: DataAccessContext = {
  correlationId: 'own-progress-correlation', facilityId, membershipId: '9c3e2f40-0000-4000-8000-000000000004',
  purposeOfUse: 'direct-care', userCookie: 'hid_access=synthetic', origin: 'https://ehr.example.test',
  actor: { id: 'staff:doctor', subject: 'staff:doctor', accountId: '9c3e2f40-0000-4000-8000-000000000005',
    roles: ['doctor'], permissions: ['ehr.prescription.read', 'ehr.lab-request.read'], facilityIds: [facilityId],
    facilities: [], authenticationMethod: 'local' } as unknown as DataAccessContext['actor'],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

function service() {
  return new WorkItemProgressService({ authorization: jest.fn() } as never);
}

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', DATABASE_SSL: 'false',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled',
    PHARMACY_API_URL: 'https://pharmacy.example.test', LAB_API_URL: 'https://lab.example.test',
    PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret', LAB_SERVICE_IDENTITY_MODE: 'local-secret',
    PHARMACY_INTERNAL_SERVICE_TOKEN: serviceToken, LAB_INTERNAL_SERVICE_TOKEN: serviceToken,
  });
  resetEnvironmentForTests();
});
afterEach(() => jest.restoreAllMocks());

describe('own pharmacy progress on prescriptions (ORD-3)', () => {
  it('asks pharmacy-api once, by POST with ids in the body, as ehr-api with the clinician\'s credentials', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ items: [
      { sourceEhrPrescriptionId: rx(2), status: 'dispensed', receivedAt: '2026-11-18T10:40:00.000Z',
        dispensedAt: '2026-11-18T11:05:00.000Z', reversedAt: null },
      { sourceEhrPrescriptionId: rx(3), status: 'received', receivedAt: '2026-11-18T10:41:00.000Z',
        dispensedAt: null, reversedAt: null },
    ] }));
    const progress = await service().pharmacy(context, patientId,
      [{ id: rx(1), status: 'draft' }, { id: rx(2), status: 'completed' }, { id: rx(3), status: 'active' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://pharmacy.example.test/api/v1/pharmacy/work-items/progress');
    expect(String(url)).not.toContain(patientId);
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ patientId, sourceEhrPrescriptionIds: [rx(2), rx(3)] });
    const headers = new Headers(options?.headers);
    expect(headers.get('x-hid-internal-caller')).toBe('ehr-api');
    expect(headers.get('x-hid-service-token')).toBe(serviceToken);
    expect(headers.get('cookie')).toBe('hid_access=synthetic');
    expect(headers.get('x-facility-id')).toBe(facilityId);
    expect(headers.get('x-purpose-of-use')).toBe('direct-care');
    expect(progress.get(rx(1))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
    expect(progress.get(rx(2))).toEqual({ status: 'dispensed', receivedAt: '2026-11-18T10:40:00.000Z',
      dispensedAt: '2026-11-18T11:05:00.000Z', reversedAt: null });
    expect(progress.get(rx(3))).toEqual({ status: 'received', receivedAt: '2026-11-18T10:41:00.000Z',
      dispensedAt: null, reversedAt: null });
  });

  it('does not call at all when every item is a draft', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const progress = await service().pharmacy(context, patientId, [{ id: rx(1), status: 'draft' }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(progress.get(rx(1))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
  });

  it.each([
    ['the service is down', () => Promise.reject(new TypeError('fetch failed'))],
    ['the service refuses', () => Promise.resolve(json({ code: 'PHARMACY_ACCESS_DENIED' }, 403))],
    ['the answer has the wrong ids', () => Promise.resolve(json({ items: [{ sourceEhrPrescriptionId: rx(9),
      status: 'received', receivedAt: null, dispensedAt: null, reversedAt: null }] }))],
    ['the answer has an unknown status', () => Promise.resolve(json({ items: [{ sourceEhrPrescriptionId: rx(2),
      status: 'accepted', receivedAt: null, dispensedAt: null, reversedAt: null }] }))],
    ['the answer is not a list', () => Promise.resolve(json({ ok: true }))],
  ])('answers unknown, without failing, when %s', async (_case, answer) => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(answer as never);
    const progress = await service().pharmacy(context, patientId,
      [{ id: rx(1), status: 'draft' }, { id: rx(2), status: 'active' }]);
    expect(progress.get(rx(1))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
    expect(progress.get(rx(2))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
  });

  it('answers unknown without calling when no delegated credentials are present', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const progress = await service().pharmacy({ ...context, userCookie: undefined, authorization: undefined },
      patientId, [{ id: rx(2), status: 'active' }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(progress.get(rx(2))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
  });

  it('asks at most 100 ids per call, and uses a short time limit', async () => {
    const items = Array.from({ length: OWN_PROGRESS_BATCH + 1 }, (_, index) => ({ id: rx(index + 1), status: 'active' }));
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as { sourceEhrPrescriptionIds: string[] };
      return json({ items: body.sourceEhrPrescriptionIds.map((id) => ({ sourceEhrPrescriptionId: id,
        status: 'not_received', receivedAt: null, dispensedAt: null, reversedAt: null })) });
    });
    const progress = await service().pharmacy(context, patientId, items);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).sourceEhrPrescriptionIds).toHaveLength(OWN_PROGRESS_BATCH);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body)).sourceEhrPrescriptionIds).toHaveLength(1);
    expect([...progress.values()].every((value) => value.status === 'not_received')).toBe(true);
    expect(OWN_PROGRESS_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });
});

describe('own laboratory progress on lab requests (ORD-3)', () => {
  it('asks lab-api and maps each status', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ items: [
      { sourceEhrOrderId: rx(2), status: 'results_ready', receivedAt: '2026-11-18T09:00:00.000Z',
        collectedAt: '2026-11-18T09:30:00.000Z', lastResultAt: '2026-11-18T11:05:00.000Z' },
    ] }));
    const progress = await service().lab(context, patientId, [{ id: rx(1), status: 'draft' }, { id: rx(2), status: 'active' }]);
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://lab.example.test/api/v1/lab/work-items/progress');
    expect(JSON.parse(String(options?.body))).toEqual({ patientId, sourceEhrOrderIds: [rx(2)] });
    expect(new Headers(options?.headers).get('x-hid-internal-caller')).toBe('ehr-api');
    expect(progress.get(rx(1))).toEqual(LAB_PROGRESS_NOT_RECEIVED);
    expect(progress.get(rx(2))).toEqual({ status: 'results_ready', receivedAt: '2026-11-18T09:00:00.000Z',
      collectedAt: '2026-11-18T09:30:00.000Z', lastResultAt: '2026-11-18T11:05:00.000Z' });
  });

  it('answers unknown when the laboratory cannot be reached', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const progress = await service().lab(context, patientId, [{ id: rx(2), status: 'on_hold' }]);
    expect(progress.get(rx(2))).toEqual(LAB_PROGRESS_UNKNOWN);
  });
});

describe('the EHR list and get answers carry ownProgress (ORD-3)', () => {
  const request = { actor: { id: 'staff:doctor', subject: 'staff:doctor', accountId: 'account', roles: [], permissions: [],
    facilityIds: [facilityId], facilities: [], facility: { membershipId: 'membership' }, authenticationMethod: 'local' },
  facilityId, correlationId: 'correlation-123456', method: 'GET',
  header: (name: string) => ({ 'x-purpose-of-use': 'direct-care', cookie: 'hid_access=synthetic' } as Record<string, string>)[name] } as unknown as HidRequest;

  it('prescriptions: each listed item and a single one', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as { sourceEhrPrescriptionIds: string[] };
      return json({ items: body.sourceEhrPrescriptionIds.map((id) => ({ sourceEhrPrescriptionId: id, status: 'dispensed',
        receivedAt: '2026-11-18T10:40:00.000Z', dispensedAt: '2026-11-18T11:05:00.000Z', reversedAt: null })) });
    });
    const prescriptions = { list: jest.fn().mockResolvedValue({ items: [{ id: rx(1), status: 'active' },
      { id: rx(2), status: 'draft' }], nextCursor: null, crossFacilityOrders: false }),
    get: jest.fn().mockResolvedValue({ id: rx(1), status: 'active' }) };
    const controller = new PrescriptionsController(prescriptions as never, service(), {} as never);
    const page = await controller.list(request, patientId, encounterId, { limit: 50 } as never);
    expect(page).toMatchObject({ nextCursor: null, crossFacilityOrders: false, items: [
      { id: rx(1), ownProgress: { status: 'dispensed', dispensedAt: '2026-11-18T11:05:00.000Z' } },
      { id: rx(2), ownProgress: PHARMACY_PROGRESS_NOT_RECEIVED }] });
    expect(await controller.get(request, patientId, encounterId, rx(1))).toMatchObject({ id: rx(1),
      ownProgress: { status: 'dispensed' } });
  });

  it('lab requests: unknown when lab-api fails, and the answer still comes', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ code: 'LAB_SERVICE_UNAVAILABLE' }, 503));
    const labRequests = { list: jest.fn().mockResolvedValue({ items: [{ id: rx(1), status: 'active' }], nextCursor: null }),
      get: jest.fn().mockResolvedValue({ id: rx(1), status: 'active' }) };
    const controller = new LabRequestsController(labRequests as never, service());
    expect(await controller.list(request, patientId, encounterId, { limit: 50 } as never)).toMatchObject({
      items: [{ id: rx(1), ownProgress: LAB_PROGRESS_UNKNOWN }] });
    expect(await controller.get(request, patientId, encounterId, rx(1))).toMatchObject({ ownProgress: LAB_PROGRESS_UNKNOWN });
  });
});
