import { Logger } from '@nestjs/common';
import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { LAB_PROGRESS_BATCH_PATH, LAB_PROGRESS_NOT_RECEIVED, LAB_PROGRESS_UNKNOWN, OWN_PROGRESS_BATCH,
  OWN_PROGRESS_BATCH_PATIENTS, OWN_PROGRESS_BATCH_TIMEOUT_MS, OWN_PROGRESS_FALLBACK_CONCURRENCY,
  OwnProgressSlots, PHARMACY_PROGRESS_BATCH_PATH, PHARMACY_PROGRESS_NOT_RECEIVED, PHARMACY_PROGRESS_UNKNOWN,
  type PatientOrders, WorkItemProgressService } from './work-item-progress.service';

// Decision 4: several patients in one own-progress call, for "Ordered by me" (MY-1). Fictional ids only.
const facilityId = '9c3e2f40-0000-4000-8000-000000000002';
const patient = (n: number) => `9c3e2f40-0000-4000-8001-${String(n).padStart(12, '0')}`;
const order = (n: number) => `9c3e2f40-0000-4000-8002-${String(n).padStart(12, '0')}`;
const serviceToken = 's'.repeat(32);
const PHARMACY_BATCH_URL = 'https://pharmacy.example.test/api/v1/pharmacy/work-items/progress/batch';
const LAB_BATCH_URL = 'https://lab.example.test/api/v1/lab/work-items/progress/batch';
const PHARMACY_SINGLE_URL = 'https://pharmacy.example.test/api/v1/pharmacy/work-items/progress';
const LAB_SINGLE_URL = 'https://lab.example.test/api/v1/lab/work-items/progress';

const context: DataAccessContext = {
  correlationId: 'own-progress-batch-correlation', facilityId, membershipId: '9c3e2f40-0000-4000-8000-000000000004',
  purposeOfUse: 'direct-care', userCookie: 'hid_access=synthetic', origin: 'https://ehr.example.test',
  actor: { id: 'staff:doctor', subject: 'staff:doctor', accountId: '9c3e2f40-0000-4000-8000-000000000005',
    roles: ['doctor'], permissions: ['ehr.prescription.read', 'ehr.lab-request.read'], facilityIds: [facilityId],
    facilities: [], authenticationMethod: 'local' } as unknown as DataAccessContext['actor'],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });
const notFound = () => json({ type: 'about:blank', title: 'Not Found', status: 404, code: 'NOT_FOUND' }, 404);

function service(authorization = jest.fn()) {
  return new WorkItemProgressService({ authorization } as never);
}

type Init = RequestInit | undefined;
const bodyOf = (init: Init) => JSON.parse(String(init?.body)) as Record<string, unknown>;
const headersOf = (init: Init) => new Headers(init?.headers);
const batchBody = (init: Init) => bodyOf(init) as { patients: Array<{ patientId: string } & Record<string, string[]>> };

const received = (id: string) => ({ sourceEhrPrescriptionId: id, status: 'received',
  receivedAt: '2026-11-20T08:10:00.000Z', dispensedAt: null, reversedAt: null, acceptedAt: null });
const PHARMACY_RECEIVED = { status: 'received', receivedAt: '2026-11-20T08:10:00.000Z', acceptedAt: null,
  dispensedAt: null, reversedAt: null };

/** pharmacy-api with the batch form: every patient answered, every id received. */
async function pharmacyEcho(url: unknown, init: Init) {
  if (String(url) === PHARMACY_BATCH_URL) {
    return json({ patients: batchBody(init).patients.map((entry) => ({ patientId: entry.patientId,
      outcome: 'answered', items: entry.sourceEhrPrescriptionIds!.map(received) })) });
  }
  return json({ items: (bodyOf(init).sourceEhrPrescriptionIds as string[]).map(received) });
}

/** A fetch that never answers; it rejects as fetch does once its signal aborts. */
function hanging(_url: unknown, init: Init) {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(new DOMException('This operation was aborted', 'AbortError'));
    signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  });
}

/**
 * A 200 whose headers arrive at once and whose body stalls after its first
 * bytes: the client's own time limit and its use of the signal end with the
 * headers, so only call()'s own race can end the wait for this body.
 */
const stalled = () => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(new TextEncoder().encode('{"patients":['));
} }), { status: 200, headers: { 'content-type': 'application/json' } });

const onePerPatient = (count: number, from = 1): PatientOrders[] => Array.from({ length: count },
  (_, index) => ({ patientId: patient(from + index), items: [{ id: order(from + index), status: 'active' }] }));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** The promise's value, or 'still pending' if it has not settled within `ms` (real timers), so a regression fails fast. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'still pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'still pending'>((resolve) => { timer = setTimeout(() => resolve('still pending'), ms); });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', DATABASE_SSL: 'false',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled',
    PHARMACY_API_URL: 'https://pharmacy.example.test', LAB_API_URL: 'https://lab.example.test',
    PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret', LAB_SERVICE_IDENTITY_MODE: 'local-secret',
    PHARMACY_INTERNAL_SERVICE_TOKEN: serviceToken, LAB_INTERNAL_SERVICE_TOKEN: serviceToken,
  });
  delete process.env.PHARMACY_EHR_WORKLOAD_TOKEN_FILE;
  delete process.env.LAB_EHR_WORKLOAD_TOKEN_FILE;
  resetEnvironmentForTests();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('C1: one batch call for the page', () => {
  it('POSTs the batch form once with { patients }, leaving out drafts and a patient with drafts only', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ patients: [
      { patientId: patient(1), outcome: 'answered', items: [
        { sourceEhrPrescriptionId: order(2), status: 'dispensed', receivedAt: '2026-11-20T08:10:00.000Z',
          acceptedAt: '2026-11-20T08:20:00.000Z', dispensedAt: '2026-11-20T08:40:00.000Z', reversedAt: null },
        received(order(3))] },
      { patientId: patient(3), outcome: 'answered', items: [received(order(5))] }] }));
    const progress = await service().pharmacyForPatients(context, [
      { patientId: patient(1), items: [{ id: order(1), status: 'draft' }, { id: order(2), status: 'completed' },
        { id: order(3), status: 'active' }] },
      { patientId: patient(2), items: [{ id: order(4), status: 'draft' }] },
      { patientId: patient(3), items: [{ id: order(5), status: 'on_hold' }] }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(PHARMACY_BATCH_URL);
    expect(init?.method).toBe('POST');
    expect(bodyOf(init)).toEqual({ patients: [
      { patientId: patient(1), sourceEhrPrescriptionIds: [order(2), order(3)] },
      { patientId: patient(3), sourceEhrPrescriptionIds: [order(5)] }] });
    // Every input id is in the map, in the order given.
    expect([...progress.keys()]).toEqual([order(1), order(2), order(3), order(4), order(5)]);
    expect(progress.get(order(1))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
    expect(progress.get(order(2))).toEqual({ status: 'dispensed', receivedAt: '2026-11-20T08:10:00.000Z',
      acceptedAt: '2026-11-20T08:20:00.000Z', dispensedAt: '2026-11-20T08:40:00.000Z', reversedAt: null });
    expect(progress.get(order(3))).toEqual(PHARMACY_RECEIVED);
    expect(progress.get(order(4))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
    expect(progress.get(order(5))).toEqual(PHARMACY_RECEIVED);
  });

  it('asks lab-api the same way, with sourceEhrOrderIds', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ patients: [
      { patientId: patient(1), outcome: 'answered', items: [{ sourceEhrOrderId: order(2), status: 'results_ready',
        receivedAt: '2026-11-20T08:00:00.000Z', collectedAt: '2026-11-20T08:30:00.000Z',
        lastResultAt: '2026-11-20T10:05:00.000Z' }] }] }));
    const progress = await service().labForPatients(context, [{ patientId: patient(1),
      items: [{ id: order(1), status: 'draft' }, { id: order(2), status: 'active' }] }]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(LAB_BATCH_URL);
    expect(bodyOf(init)).toEqual({ patients: [{ patientId: patient(1), sourceEhrOrderIds: [order(2)] }] });
    expect(progress.get(order(1))).toEqual(LAB_PROGRESS_NOT_RECEIVED);
    expect(progress.get(order(2))).toEqual({ status: 'results_ready', receivedAt: '2026-11-20T08:00:00.000Z',
      collectedAt: '2026-11-20T08:30:00.000Z', lastResultAt: '2026-11-20T10:05:00.000Z' });
  });

  it('makes no call when nothing is sendable, and every id is not received', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const progress = await service().pharmacyForPatients(context, [
      { patientId: patient(1), items: [{ id: order(1), status: 'draft' }] },
      { patientId: patient(2), items: [] },
      { patientId: patient(3), items: [{ id: order(3), status: 'draft' }] }]);
    expect(fetch).not.toHaveBeenCalled();
    expect([...progress]).toEqual([[order(1), PHARMACY_PROGRESS_NOT_RECEIVED], [order(3), PHARMACY_PROGRESS_NOT_RECEIVED]]);
    expect((await service().labForPatients(context, [])).size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names the binding constants', () => {
    expect([OWN_PROGRESS_BATCH, OWN_PROGRESS_BATCH_PATIENTS, OWN_PROGRESS_BATCH_TIMEOUT_MS,
      OWN_PROGRESS_FALLBACK_CONCURRENCY]).toEqual([100, 50, 3_500, 6]);
    expect(PHARMACY_PROGRESS_BATCH_PATH).toBe('/api/v1/pharmacy/work-items/progress/batch');
    expect(LAB_PROGRESS_BATCH_PATH).toBe('/api/v1/lab/work-items/progress/batch');
  });
});

describe('C2: headers', () => {
  const asked = [{ patientId: patient(1), items: [{ id: order(1), status: 'active' }] }];
  const labEcho = async (_url: unknown, init: Init) => json({ patients: batchBody(init).patients.map((entry) => ({
    patientId: entry.patientId, outcome: 'answered', items: entry.sourceEhrOrderIds!.map((id) => ({ sourceEhrOrderId: id,
      status: 'received', receivedAt: null, collectedAt: null, lastResultAt: null })) })) });

  it('sends today\'s headers; both version headers on the pharmacy call only; no patient id in any URL', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => (String(url).includes('/pharmacy/')
      ? pharmacyEcho(url, init) : labEcho(url, init)));
    await service().pharmacyForPatients(context, asked);
    await service().labForPatients(context, asked);
    const [pharmacyCall, labCall] = fetch.mock.calls;
    for (const [url, init] of [pharmacyCall!, labCall!]) {
      expect(String(url)).not.toContain(patient(1));
      const headers = headersOf(init);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('x-hid-internal-caller')).toBe('ehr-api');
      expect(headers.get('x-hid-service-token')).toBe(serviceToken);
      expect(headers.has('x-hid-service-authorization')).toBe(false);
      expect(headers.get('cookie')).toBe('hid_access=synthetic');
      expect(headers.get('origin')).toBe('https://ehr.example.test');
      expect(headers.get('x-facility-id')).toBe(facilityId);
      expect(headers.get('x-purpose-of-use')).toBe('direct-care');
      expect(headers.get('x-correlation-id')).toBe('own-progress-batch-correlation');
    }
    expect(headersOf(pharmacyCall![1]).get('x-hid-own-progress')).toBe('0133');
    expect(headersOf(pharmacyCall![1]).get('x-hid-own-progress-accepted')).toBe('ord4');
    expect(headersOf(labCall![1]).has('x-hid-own-progress')).toBe(false);
    expect(headersOf(labCall![1]).has('x-hid-own-progress-accepted')).toBe(false);
  });

  it('sends the workload token instead of the shared secret in jwt mode', async () => {
    Object.assign(process.env, { PHARMACY_SERVICE_IDENTITY_MODE: 'jwt', LAB_SERVICE_IDENTITY_MODE: 'jwt',
      PHARMACY_EHR_WORKLOAD_TOKEN_FILE: '/run/synthetic/pharmacy-token', LAB_EHR_WORKLOAD_TOKEN_FILE: '/run/synthetic/lab-token' });
    resetEnvironmentForTests();
    const authorization = jest.fn(async (audience: string) => `Bearer synthetic-${audience}-jwt`);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => (String(url).includes('/pharmacy/')
      ? pharmacyEcho(url, init) : labEcho(url, init)));
    const progress = service(authorization);
    await progress.pharmacyForPatients(context, asked);
    await progress.labForPatients(context, asked);
    const [pharmacyCall, labCall] = fetch.mock.calls;
    expect(headersOf(pharmacyCall![1]).get('x-hid-service-authorization')).toBe('Bearer synthetic-pharmacy-jwt');
    expect(headersOf(labCall![1]).get('x-hid-service-authorization')).toBe('Bearer synthetic-lab-jwt');
    expect(headersOf(pharmacyCall![1]).has('x-hid-service-token')).toBe(false);
    expect(headersOf(labCall![1]).has('x-hid-service-token')).toBe(false);
  });
});

describe('C3: packing', () => {
  const sizes = (fetch: jest.SpyInstance) => fetch.mock.calls.map(([, init]) => batchBody(init as Init).patients
    .map((entry) => entry.sourceEhrPrescriptionIds!.length));

  it('50 patients with one id each are one call; 51 are two (50, then 1)', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(pharmacyEcho);
    const fifty = await service().pharmacyForPatients(context, onePerPatient(OWN_PROGRESS_BATCH_PATIENTS));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...fifty.values()].every((value) => value.status === 'received')).toBe(true);
    fetch.mockClear();
    const fiftyOne = await service().pharmacyForPatients(context, onePerPatient(OWN_PROGRESS_BATCH_PATIENTS + 1));
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([PHARMACY_BATCH_URL, PHARMACY_BATCH_URL]);
    expect(sizes(fetch).map((call) => call.length)).toEqual([50, 1]);
    expect(fiftyOne.size).toBe(51);
    expect([...fiftyOne.values()].every((value) => value.status === 'received')).toBe(true);
  });

  it('60 and 60 ids are two calls; one patient with 150 ids is two calls (100, 50), the patient once in each', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(pharmacyEcho);
    const many = (from: number, count: number) => Array.from({ length: count },
      (_, index) => ({ id: order(from + index), status: 'active' }));
    await service().pharmacyForPatients(context, [{ patientId: patient(1), items: many(1, 60) },
      { patientId: patient(2), items: many(101, 60) }]);
    expect(sizes(fetch)).toEqual([[60], [60]]);
    fetch.mockClear();
    const progress = await service().pharmacyForPatients(context, [{ patientId: patient(1), items: many(1, 150) }]);
    expect(sizes(fetch)).toEqual([[100], [50]]);
    expect(fetch.mock.calls.map(([, init]) => batchBody(init).patients.map((entry) => entry.patientId)))
      .toEqual([[patient(1)], [patient(1)]]);
    expect(batchBody(fetch.mock.calls[1]![1]).patients[0]!.sourceEhrPrescriptionIds![0]).toBe(order(101));
    expect(progress.size).toBe(150);
    expect([...progress.values()].every((value) => value.status === 'received')).toBe(true);
  });

  it('runs the calls one after another', async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (fetch.mock.calls.length === 1) await firstHeld;
      return pharmacyEcho(url, init);
    });
    const pending = service().pharmacyForPatients(context, onePerPatient(OWN_PROGRESS_BATCH_PATIENTS + 1));
    for (let turn = 0; turn < 5; turn += 1) await nextTurn();
    expect(fetch).toHaveBeenCalledTimes(1);
    releaseFirst();
    const progress = await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(progress.get(order(51))).toEqual(PHARMACY_RECEIVED);
  });
});

describe('C4: each patient\'s entry', () => {
  it('maps an answered entry as pharmacy() does; denied, unavailable, other and bad items are unknown for that '
    + 'patient only, logged by counts and codes', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const accepted = { sourceEhrPrescriptionId: order(1), status: 'accepted', receivedAt: '2026-11-20T08:10:00.000Z',
      acceptedAt: '2026-11-20T08:12:00.000Z', dispensedAt: null, reversedAt: null };
    // A Release A pharmacy-api has no acceptedAt: it reads as null, as on the one-patient route.
    const withoutAcceptedAt = { sourceEhrPrescriptionId: order(2), status: 'withdrawn',
      receivedAt: '2026-11-20T08:11:00.000Z', dispensedAt: null, reversedAt: null };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ patients: [
      { patientId: patient(1), outcome: 'answered', items: [accepted] },
      { patientId: patient(2), outcome: 'answered', items: [withoutAcceptedAt] },
      { patientId: patient(3), outcome: 'denied', code: 'PHARMACY_ACCESS_DENIED', items: [received(order(3))] },
      { patientId: patient(4), outcome: 'denied', code: 'CONSENT_REQUIRED' },
      { patientId: patient(5), outcome: 'unavailable', code: 'PROGRESS_CHECK_TIME_LIMIT' },
      // Only a code of the services' shape is logged; anything else (here an id) is counted without it.
      { patientId: patient(6), outcome: 'unavailable', code: order(6) },
      { patientId: patient(7), outcome: 'answered', items: [{ ...received(order(7)), status: 'ready' }] },
      { patientId: patient(8), outcome: 'postponed', items: [received(order(8))] },
    ] }));
    const progress = await service().pharmacyForPatients(context, onePerPatient(8));
    expect(progress.get(order(1))).toEqual({ status: 'accepted', receivedAt: '2026-11-20T08:10:00.000Z',
      acceptedAt: '2026-11-20T08:12:00.000Z', dispensedAt: null, reversedAt: null });
    expect(progress.get(order(2))).toEqual({ status: 'withdrawn', receivedAt: '2026-11-20T08:11:00.000Z',
      acceptedAt: null, dispensedAt: null, reversedAt: null });
    for (const n of [3, 4, 5, 6, 7, 8]) expect(progress.get(order(n))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
    expect(warn.mock.calls.map(([message]) => message)).toEqual(['Own pharmacy progress is unknown for 6 of 8 patients: '
      + 'denied 2 (CONSENT_REQUIRED, PHARMACY_ACCESS_DENIED); unavailable 2 (PROGRESS_CHECK_TIME_LIMIT); malformed 1; '
      + 'other 1']);

    // The same items through the one-patient route read the same.
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ items: [accepted] }));
    expect((await service().pharmacy(context, patient(1), [{ id: order(1) }])).get(order(1)))
      .toEqual(progress.get(order(1)));
  });

  it('leaves out the groups that are empty and the parentheses when no code is logged', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ patients: [
      { patientId: patient(1), outcome: 'answered', items: [{ sourceEhrOrderId: order(1), status: 'received',
        receivedAt: null, collectedAt: null, lastResultAt: null }] },
      { patientId: patient(2), outcome: 'unavailable' }] }));
    const progress = await service().labForPatients(context, onePerPatient(2));
    expect(progress.get(order(1))).toEqual({ status: 'received', receivedAt: null, collectedAt: null, lastResultAt: null });
    expect(progress.get(order(2))).toEqual(LAB_PROGRESS_UNKNOWN);
    expect(warn.mock.calls.map(([message]) => message))
      .toEqual(['Own lab progress is unknown for 1 of 2 patients: unavailable 1']);
  });

  it('logs nothing when every patient is answered', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockImplementation(pharmacyEcho);
    await service().pharmacyForPatients(context, onePerPatient(3));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('C5: the whole call is unknown, with no fallback', () => {
  const two = () => [{ patientId: patient(1), items: [{ id: order(1), status: 'active' }, { id: order(9), status: 'draft' }] },
    { patientId: patient(2), items: [{ id: order(2), status: 'active' }] }];
  const answered = (n: number) => ({ patientId: patient(n), outcome: 'answered', items: [received(order(n))] });

  it.each([
    ['patients is not an array', () => json({ patients: { [patient(1)]: answered(1) } }), 'malformed answer'],
    ['there is no body', () => new Response(null, { status: 200 }), 'malformed answer'],
    ['an entry is missing', () => json({ patients: [answered(1)] }), 'malformed answer'],
    ['the entries are reordered', () => json({ patients: [answered(2), answered(1)] }), 'malformed answer'],
    ['a patientId differs (letter case)', () => json({ patients: [{ ...answered(1), patientId: patient(1).toUpperCase() },
      answered(2)] }), 'malformed answer'],
    ['an entry is not an object', () => json({ patients: [answered(1), null] }), 'malformed answer'],
    ['the service answers 400', () => json({ code: 'VALIDATION_FAILED' }, 400), '400 VALIDATION_FAILED'],
    ['the service answers 403', () => json({ code: 'PERMISSION_DENIED' }, 403), '403 PERMISSION_DENIED'],
    ['the service answers 500', () => json({ code: 'INTERNAL_ERROR' }, 500), '500 INTERNAL_ERROR'],
    ['the service answers 503', () => json({ code: 'IDENTITY_SERVICE_UNAVAILABLE' }, 503), '503 IDENTITY_SERVICE_UNAVAILABLE'],
    ['the network fails', () => Promise.reject(new TypeError('fetch failed')), 'TypeError'],
    ['the answer is not JSON', () => new Response('{"patients": [', { status: 200 }), 'HidInvalidJsonError'],
  ])('when %s', async (_case, answer, logged) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(answer as never);
    const progress = await service().pharmacyForPatients(context, two());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(PHARMACY_BATCH_URL);
    expect(progress.get(order(1))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
    expect(progress.get(order(2))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
    expect(progress.get(order(9))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([`Own pharmacy progress is unknown: ${logged}`]);
  });

  it('when the batch call passes 3.5 seconds (the limit aborts the batch fetch)', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(hanging);
    let settled = false;
    const pending = service().pharmacyForPatients(context, two()).then((progress) => {
      settled = true;
      return progress;
    });
    await jest.advanceTimersByTimeAsync(OWN_PROGRESS_BATCH_TIMEOUT_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0]![1]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    const progress = await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(progress.get(order(1))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
    expect(progress.get(order(2))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
    expect(warn.mock.calls.map(([message]) => message))
      .toEqual(['Own pharmacy progress is unknown: HidRequestTimeoutError']);
  });

  it('when the headers arrive but the body stalls and there is no signal: unknown at 3.5 seconds from sending '
    + '(the limit covers the body too)', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => stalled());
    let settled = false;
    const pending = service().pharmacyForPatients(context, two()).then((progress) => {
      settled = true;
      return progress;
    });
    await jest.advanceTimersByTimeAsync(OWN_PROGRESS_BATCH_TIMEOUT_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const progress = await pending;
    // The client's own limit ended with the headers, so it never aborted this fetch: call()'s own timer ended the wait.
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(progress.get(order(1))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
    expect(progress.get(order(2))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
    expect(progress.get(order(9))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
    expect(warn.mock.calls.map(([message]) => message))
      .toEqual(['Own pharmacy progress is unknown: HidRequestTimeoutError']);
    // Nothing is left running once the call has ended.
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('C6: an image without the batch form (404)', () => {
  it('asks each patient on the one-patient route with both headers, at most 6 at once', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let inFlight = 0;
    let most = 0;
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) === PHARMACY_BATCH_URL) return notFound();
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return pharmacyEcho(url, init);
    });
    const progress = await service().pharmacyForPatients(context, onePerPatient(9));
    const singles = fetch.mock.calls.slice(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(PHARMACY_BATCH_URL);
    expect(singles).toHaveLength(9);
    expect(most).toBe(OWN_PROGRESS_FALLBACK_CONCURRENCY);
    singles.forEach(([url, init], index) => {
      expect(String(url)).toBe(PHARMACY_SINGLE_URL);
      expect(bodyOf(init)).toEqual({ patientId: patient(index + 1), sourceEhrPrescriptionIds: [order(index + 1)] });
      expect(headersOf(init).get('x-hid-own-progress')).toBe('0133');
      expect(headersOf(init).get('x-hid-own-progress-accepted')).toBe('ord4');
    });
    expect([...progress.values()]).toEqual(Array.from({ length: 9 }, () => PHARMACY_RECEIVED));
    expect(log.mock.calls.map(([message]) => message))
      .toEqual(['Own pharmacy progress: no batch form (404); asking per patient']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips the batch for the rest of the invocation, and tries it again on the next', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => (String(url) === LAB_BATCH_URL
      ? notFound() : json({ items: (bodyOf(init).sourceEhrOrderIds as string[]).map((id) => ({ sourceEhrOrderId: id,
        status: 'sample_collected', receivedAt: null, collectedAt: '2026-11-20T09:00:00.000Z', lastResultAt: null })) })));
    const progress = service();
    const first = await progress.labForPatients(context, onePerPatient(OWN_PROGRESS_BATCH_PATIENTS + 1));
    const urls = () => fetch.mock.calls.map(([url]) => String(url));
    expect(urls().filter((url) => url === LAB_BATCH_URL)).toHaveLength(1);
    expect(urls().filter((url) => url.endsWith('/api/v1/lab/work-items/progress'))).toHaveLength(51);
    expect(first.get(order(51))?.status).toBe('sample_collected');
    fetch.mockClear();
    await progress.labForPatients(context, onePerPatient(1));
    expect(urls()).toEqual([LAB_BATCH_URL, 'https://lab.example.test/api/v1/lab/work-items/progress']);
  });

  /** Both services without the batch form; each one-patient call takes 5 ms, and the most in flight at once is counted. */
  function bothWithout404s() {
    const flight = { now: 0, most: 0 };
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) === PHARMACY_BATCH_URL || String(url) === LAB_BATCH_URL) return notFound();
      flight.now += 1;
      flight.most = Math.max(flight.most, flight.now);
      await new Promise((resolve) => setTimeout(resolve, 5));
      flight.now -= 1;
      if (String(url) === PHARMACY_SINGLE_URL) return pharmacyEcho(url, init);
      return json({ items: (bodyOf(init).sourceEhrOrderIds as string[]).map((id) => ({ sourceEhrOrderId: id,
        status: 'received', receivedAt: null, collectedAt: null, lastResultAt: null })) });
    });
    return { flight, fetch };
  }

  it('keeps the page to 6 one-patient calls at once across both kinds when both share one OwnProgressSlots, '
    + 'and answers every id', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { flight, fetch } = bothWithout404s();
    const progress = service();
    // As "Ordered by me" does: one OwnProgressSlots for the page, both kinds asked at once.
    const slots = new OwnProgressSlots();
    const [pharmacy, lab] = await Promise.all([
      progress.pharmacyForPatients(context, onePerPatient(25, 1), { slots }),
      progress.labForPatients(context, onePerPatient(25, 101), { slots })]);
    expect(flight.most).toBe(OWN_PROGRESS_FALLBACK_CONCURRENCY);
    expect(fetch.mock.calls.filter(([url]) => String(url) === PHARMACY_SINGLE_URL)).toHaveLength(25);
    expect(fetch.mock.calls.filter(([url]) => String(url) === LAB_SINGLE_URL)).toHaveLength(25);
    expect(pharmacy.size).toBe(25);
    expect([...pharmacy.values()].every((value) => value.status === 'received')).toBe(true);
    expect(lab.size).toBe(25);
    expect([...lab.values()].every((value) => value.status === 'received')).toBe(true);
    // Every slot came back: a later page could take all six again from this object.
    expect(await Promise.all(Array.from({ length: OWN_PROGRESS_FALLBACK_CONCURRENCY }, () => slots.take())))
      .toEqual(Array(OWN_PROGRESS_FALLBACK_CONCURRENCY).fill(true));
  });

  it('without a shared OwnProgressSlots, each invocation has its own limit of 6 (any other caller, as before)',
    async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { flight } = bothWithout404s();
      const progress = service();
      await Promise.all([progress.pharmacyForPatients(context, onePerPatient(25, 1)),
        progress.labForPatients(context, onePerPatient(25, 101))]);
      expect(flight.most).toBe(2 * OWN_PROGRESS_FALLBACK_CONCURRENCY);
    });
});

describe('OwnProgressSlots', () => {
  it('gives at most its limit at once, and hands a slot given back to the first caller waiting', async () => {
    const slots = new OwnProgressSlots(2);
    expect(slots.limit).toBe(2);
    expect(await slots.take()).toBe(true);
    expect(await slots.take()).toBe(true);
    let third: boolean | undefined;
    const waiting = slots.take().then((taken) => { third = taken; });
    await nextTurn();
    expect(third).toBeUndefined();
    slots.give();
    await waiting;
    expect(third).toBe(true);
    expect(new OwnProgressSlots().limit).toBe(OWN_PROGRESS_FALLBACK_CONCURRENCY);
  });

  it('refuses a limit that would start no call (0, -1, 0.5, NaN), so no asked id is left "not received" unasked', () => {
    for (const limit of [0, -1, 0.5, Number.NaN]) {
      expect(() => new OwnProgressSlots(limit)).toThrow(RangeError);
    }
  });

  it('lets a waiting caller go at once, without a slot, when its signal aborts; one already aborted gets none',
    async () => {
      const slots = new OwnProgressSlots(1);
      expect(await slots.take()).toBe(true);
      const page = new AbortController();
      const waiting = slots.take(page.signal);
      page.abort();
      expect(await waiting).toBe(false);
      expect(await slots.take(page.signal)).toBe(false);
      // The caller let go took nothing: the slot given back is free for the next caller at once.
      slots.give();
      expect(await within(slots.take(), 100)).toBe(true);
    });

  it('a waiter let go by the page\'s abort starts no one-patient call', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => (
      String(url) === PHARMACY_BATCH_URL || String(url) === LAB_BATCH_URL ? notFound() : hanging(url, init)));
    const calls = (url: string) => fetch.mock.calls.filter(([asked]) => String(asked) === url).length;
    const progress = service();
    const slots = new OwnProgressSlots();
    // Another invocation, on a signal that is NOT the page's, holds all six slots with one-patient calls that
    // hang: nothing the page does can give a slot back, so only the page's abort can let the waiter go.
    const holder = new AbortController();
    const holding = progress.pharmacyForPatients(context, onePerPatient(OWN_PROGRESS_FALLBACK_CONCURRENCY, 1),
      { signal: holder.signal, slots });
    while (calls(PHARMACY_SINGLE_URL) < OWN_PROGRESS_FALLBACK_CONCURRENCY) await nextTurn();
    const page = new AbortController();
    const waiting = progress.labForPatients(context, onePerPatient(3, 101), { signal: page.signal, slots });
    while (calls(LAB_BATCH_URL) < 1) await nextTurn();
    for (let turn = 0; turn < 5; turn += 1) await nextTurn();
    expect(calls(LAB_SINGLE_URL)).toBe(0);
    page.abort();
    const answered = await within(waiting, 500);
    expect(answered).not.toBe('still pending');
    const lab = answered as Awaited<typeof waiting>;
    expect(calls(LAB_SINGLE_URL)).toBe(0);
    expect(lab.size).toBe(3);
    expect([...lab.values()].every((value) => value === LAB_PROGRESS_UNKNOWN)).toBe(true);
    holder.abort();
    expect(await within(holding, 500)).not.toBe('still pending');
  });
});

describe('C7: the page\'s signal', () => {
  it('aborted before the call: no fetch, asked ids unknown, drafts not received', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const page = new AbortController();
    page.abort();
    const progress = await service().pharmacyForPatients(context, [{ patientId: patient(1),
      items: [{ id: order(1), status: 'active' }, { id: order(2), status: 'draft' }] }], { signal: page.signal });
    expect(fetch).not.toHaveBeenCalled();
    expect(progress.get(order(1))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
    expect(progress.get(order(2))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
  });

  it('aborted during the batch call: all unknown, at once, and no later call starts', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(hanging);
    const page = new AbortController();
    const pending = service().labForPatients(context, onePerPatient(OWN_PROGRESS_BATCH_PATIENTS + 1),
      { signal: page.signal });
    while (fetch.mock.calls.length === 0) await nextTurn();
    const abortedAt = Date.now();
    page.abort();
    // The page's abort reaches the batch fetch itself, at once.
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    const progress = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(progress.size).toBe(51);
    expect([...progress.values()].every((value) => value === LAB_PROGRESS_UNKNOWN)).toBe(true);
  });

  it('aborted during the fallback: the calls in flight end at once, and no new one-patient call starts', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => (String(url) === PHARMACY_BATCH_URL
      ? notFound() : hanging(url, init)));
    const page = new AbortController();
    const pending = service().pharmacyForPatients(context, onePerPatient(9), { signal: page.signal });
    while (fetch.mock.calls.length < 1 + OWN_PROGRESS_FALLBACK_CONCURRENCY) await nextTurn();
    const abortedAt = Date.now();
    page.abort();
    // The page's abort reaches each one-patient fetch in flight; without it each would run to its own 3 seconds.
    expect(fetch.mock.calls.slice(1).map(([, init]) => init?.signal?.aborted))
      .toEqual(Array(OWN_PROGRESS_FALLBACK_CONCURRENCY).fill(true));
    const progress = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(fetch).toHaveBeenCalledTimes(1 + OWN_PROGRESS_FALLBACK_CONCURRENCY);
    expect([...progress.values()].every((value) => value === PHARMACY_PROGRESS_UNKNOWN)).toBe(true);
    expect(progress.size).toBe(9);
    // Only the calls in flight failed; the three patients still queued were never asked.
    expect(warn).toHaveBeenCalledTimes(OWN_PROGRESS_FALLBACK_CONCURRENCY);
  });

  it('aborted during the lab fallback: the same, through lab()', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => (String(url) === LAB_BATCH_URL
      ? notFound() : hanging(url, init)));
    const page = new AbortController();
    const pending = service().labForPatients(context, onePerPatient(9), { signal: page.signal });
    while (fetch.mock.calls.length < 1 + OWN_PROGRESS_FALLBACK_CONCURRENCY) await nextTurn();
    const abortedAt = Date.now();
    page.abort();
    expect(fetch.mock.calls.slice(1).map(([url, init]) => [String(url), init?.signal?.aborted]))
      .toEqual(Array(OWN_PROGRESS_FALLBACK_CONCURRENCY).fill([LAB_SINGLE_URL, true]));
    const progress = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(fetch).toHaveBeenCalledTimes(1 + OWN_PROGRESS_FALLBACK_CONCURRENCY);
    expect(progress.size).toBe(9);
    expect([...progress.values()].every((value) => value === LAB_PROGRESS_UNKNOWN)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(OWN_PROGRESS_FALLBACK_CONCURRENCY);
  });

  it('aborted after the batch call\'s headers, while its body stalls: all unknown within 500 ms, and no later call '
    + 'starts', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => stalled());
    const page = new AbortController();
    const pending = service().pharmacyForPatients(context, onePerPatient(OWN_PROGRESS_BATCH_PATIENTS + 1),
      { signal: page.signal });
    while (fetch.mock.calls.length === 0) await nextTurn();
    for (let turn = 0; turn < 5; turn += 1) await nextTurn();
    const abortedAt = Date.now();
    page.abort();
    // The headers had arrived: the client no longer passes the page's abort to this fetch, so only call()'s race ends it.
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(false);
    const progress = await within(pending, 1_000);
    expect(progress).not.toBe('still pending');
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(fetch).toHaveBeenCalledTimes(1);
    const answered = progress as Map<string, unknown>;
    expect(answered.size).toBe(OWN_PROGRESS_BATCH_PATIENTS + 1);
    expect([...answered.values()].every((value) => value === PHARMACY_PROGRESS_UNKNOWN)).toBe(true);
    // One line, for the call abandoned (the abort's DOMException is from another realm under jest, so its name may
    // read 'error' here; in the service it is 'AbortError', as for an abort before the headers).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^Own pharmacy progress is unknown: (AbortError|error)$/);
  });

  it('aborted during the fallback while the one-patient bodies stall after their headers: all unknown within 500 ms',
    async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (String(url) === LAB_BATCH_URL
        ? notFound() : stalled()));
      const page = new AbortController();
      const pending = service().labForPatients(context, onePerPatient(9), { signal: page.signal });
      while (fetch.mock.calls.length < 1 + OWN_PROGRESS_FALLBACK_CONCURRENCY) await nextTurn();
      for (let turn = 0; turn < 5; turn += 1) await nextTurn();
      const abortedAt = Date.now();
      page.abort();
      // Every one-patient call in flight had its headers: the page's abort no longer reaches their fetches.
      expect(fetch.mock.calls.slice(1).map(([url, init]) => [String(url), init?.signal?.aborted]))
        .toEqual(Array(OWN_PROGRESS_FALLBACK_CONCURRENCY).fill([LAB_SINGLE_URL, false]));
      const progress = await within(pending, 1_000);
      expect(progress).not.toBe('still pending');
      expect(Date.now() - abortedAt).toBeLessThan(500);
      expect(fetch).toHaveBeenCalledTimes(1 + OWN_PROGRESS_FALLBACK_CONCURRENCY);
      const answered = progress as Map<string, unknown>;
      expect(answered.size).toBe(9);
      expect([...answered.values()].every((value) => value === LAB_PROGRESS_UNKNOWN)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(OWN_PROGRESS_FALLBACK_CONCURRENCY);
    });

  it('the one-patient route starts nothing when its signal has already aborted', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(pharmacyEcho);
    const page = new AbortController();
    page.abort();
    const progress = await service().pharmacy(context, patient(1), [{ id: order(1), status: 'active' }],
      { signal: page.signal });
    expect(fetch).not.toHaveBeenCalled();
    expect(progress.get(order(1))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
  });

  it('lab()\'s one-patient route starts nothing when its signal has already aborted, as pharmacy()\'s does', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => json({
      items: (bodyOf(init).sourceEhrOrderIds as string[]).map((id) => ({ sourceEhrOrderId: id, status: 'received',
        receivedAt: '2026-11-20T08:00:00.000Z', collectedAt: null, lastResultAt: null })) }));
    const page = new AbortController();
    page.abort();
    const progress = await service().lab(context, patient(1), [{ id: order(1), status: 'active' }],
      { signal: page.signal });
    expect(fetch).not.toHaveBeenCalled();
    expect(progress.get(order(1))).toEqual(LAB_PROGRESS_UNKNOWN);
  });

  /**
   * The first slice's answer, which aborts the page as ehr-api reads it. A
   * call still in flight when the page aborts is abandoned (its ids are
   * unknown), so to show the check before EACH later slice the abort must
   * land after the first slice's call has ended and before the second could
   * start: `ok` is read first by call() once the answer is settled, and
   * nothing in between waits on anything else.
   */
  function answeredThenAborted(response: Response, page: AbortController): Response {
    Object.defineProperty(response, 'ok', { get: () => {
      page.abort();
      return true;
    } });
    return response;
  }
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: order(index + 1), status: 'active' }));

  it('the one-patient route starts nothing once its signal has aborted (its later slices of 100 included)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const page = new AbortController();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => answeredThenAborted(
      await pharmacyEcho(url, init), page));
    const progress = await service().pharmacy(context, patient(1), many(150), { signal: page.signal });
    expect(page.signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((bodyOf(fetch.mock.calls[0]![1]).sourceEhrPrescriptionIds as string[])).toHaveLength(OWN_PROGRESS_BATCH);
    expect(progress.size).toBe(150);
    for (let n = 1; n <= 100; n += 1) expect(progress.get(order(n))).toEqual(PHARMACY_RECEIVED);
    for (let n = 101; n <= 150; n += 1) expect(progress.get(order(n))).toEqual(PHARMACY_PROGRESS_UNKNOWN);
  });

  it('lab()\'s one-patient route starts nothing once its signal has aborted, its later slices of 100 included',
    async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const page = new AbortController();
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => answeredThenAborted(json({
        items: (bodyOf(init).sourceEhrOrderIds as string[]).map((id) => ({ sourceEhrOrderId: id, status: 'received',
          receivedAt: '2026-11-20T08:00:00.000Z', collectedAt: null, lastResultAt: null })) }), page));
      const progress = await service().lab(context, patient(1), many(150), { signal: page.signal });
      expect(page.signal.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((bodyOf(fetch.mock.calls[0]![1]).sourceEhrOrderIds as string[])).toHaveLength(OWN_PROGRESS_BATCH);
      expect(progress.size).toBe(150);
      for (let n = 1; n <= 100; n += 1) {
        expect(progress.get(order(n))).toEqual({ status: 'received', receivedAt: '2026-11-20T08:00:00.000Z',
          collectedAt: null, lastResultAt: null });
      }
      for (let n = 101; n <= 150; n += 1) expect(progress.get(order(n))).toEqual(LAB_PROGRESS_UNKNOWN);
    });
});

describe('C8: a purpose other than direct care', () => {
  it('asks each patient on the one-patient route, never the batch form', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(pharmacyEcho);
    const progress = await service().pharmacyForPatients({ ...context, purposeOfUse: 'emergency' }, onePerPatient(3));
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([PHARMACY_SINGLE_URL, PHARMACY_SINGLE_URL,
      PHARMACY_SINGLE_URL]);
    expect(fetch.mock.calls.map(([, init]) => headersOf(init).get('x-purpose-of-use')))
      .toEqual(['emergency', 'emergency', 'emergency']);
    expect([...progress.values()]).toEqual([PHARMACY_RECEIVED, PHARMACY_RECEIVED, PHARMACY_RECEIVED]);
  });
});

describe('C9: the log names no patient and no order', () => {
  it('in every path: refusals, malformed answers, failures, the 404 and its fallback', async () => {
    const lines: string[] = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => { lines.push(String(message)); });
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => { lines.push(String(message)); });
    const answers: Array<(url: unknown, init: Init) => Promise<Response> | Response> = [
      (_url, init) => json({ patients: batchBody(init).patients.map((entry, index) => (index === 0
        ? { patientId: entry.patientId, outcome: 'answered', items: [{ ...received(order(1)), status: 'lost' }] }
        : { patientId: entry.patientId, outcome: index === 1 ? 'denied' : 'unavailable',
          code: index === 1 ? `DENIED ${entry.patientId}` : entry.sourceEhrPrescriptionIds![0] })) }),
      () => json({ patients: [{ patientId: patient(9) }] }),
      () => json({ code: 'PHARMACY_ACCESS_DENIED', detail: patient(1) }, 403),
      () => Promise.reject(new TypeError(`fetch failed for ${order(1)}`)),
      (url) => (String(url) === PHARMACY_BATCH_URL ? notFound() : json({ code: 'PHARMACY_ACCESS_DENIED' }, 403)),
    ];
    for (const answer of answers) {
      jest.spyOn(globalThis, 'fetch').mockImplementation(answer as never);
      await service().pharmacyForPatients(context, onePerPatient(3));
    }
    expect(lines.length).toBeGreaterThanOrEqual(answers.length);
    const named = [1, 2, 3, 9].flatMap((n) => [patient(n), order(n)]);
    for (const line of lines) {
      for (const id of named) expect(line.toLowerCase()).not.toContain(id.toLowerCase());
    }
  });
});

describe('C10: one patient and one id once in a call', () => {
  it('merges a patient named again in another letter case, and asks a repeated id once', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(pharmacyEcho);
    const progress = await service().pharmacyForPatients(context, [
      { patientId: patient(1), items: [{ id: order(1), status: 'active' }] },
      { patientId: patient(2), items: [{ id: order(2), status: 'active' }, { id: order(1), status: 'active' }] },
      { patientId: patient(1).toUpperCase(), items: [{ id: order(3), status: 'active' },
        { id: order(1).toUpperCase(), status: 'active' }, { id: order(3), status: 'active' }] }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetch.mock.calls[0]![1])).toEqual({ patients: [
      { patientId: patient(1), sourceEhrPrescriptionIds: [order(1), order(3)] },
      { patientId: patient(2), sourceEhrPrescriptionIds: [order(2)] }] });
    // Every spelling the page used reads the answer.
    expect([...progress.keys()]).toEqual([order(1), order(2), order(3), order(1).toUpperCase()]);
    expect([...progress.values()]).toEqual([PHARMACY_RECEIVED, PHARMACY_RECEIVED, PHARMACY_RECEIVED, PHARMACY_RECEIVED]);
  });
});

describe('C11: onAnswer, each id as soon as it is known', () => {
  it('a draft before any call; each patient as its one-patient answer is read; a patient still waiting is unknown at '
    + 'the abort; each id told once, as returned', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const told: Array<[string, unknown]> = [];
    const toldAtFirstFetch: Array<Array<[string, unknown]>> = [];
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (toldAtFirstFetch.length === 0) toldAtFirstFetch.push([...told]);
      if (String(url) === PHARMACY_BATCH_URL) return notFound();
      return bodyOf(init).patientId === patient(2) ? hanging(url, init) : pharmacyEcho(url, init);
    });
    const page = new AbortController();
    const pending = service().pharmacyForPatients(context, [...onePerPatient(3),
      { patientId: patient(4), items: [{ id: order(4), status: 'draft' }] }],
    { signal: page.signal, onAnswer: (id, progress) => told.push([id, progress]) });
    while (told.length < 3) await nextTurn();
    expect(toldAtFirstFetch).toEqual([[[order(4), PHARMACY_PROGRESS_NOT_RECEIVED]]]);
    // Patients 1 and 3 are told while patient 2's call is still open.
    expect(new Map(told)).toEqual(new Map<string, unknown>([[order(4), PHARMACY_PROGRESS_NOT_RECEIVED],
      [order(1), PHARMACY_RECEIVED], [order(3), PHARMACY_RECEIVED]]));
    expect(fetch).toHaveBeenCalledTimes(4);
    page.abort();
    const progress = await pending;
    expect(told).toHaveLength(4);
    expect(told[3]).toEqual([order(2), PHARMACY_PROGRESS_UNKNOWN]);
    expect(new Map(told)).toEqual(progress);
  });

  it('in a batch answer, each spelling the page used is told once, with the value returned for it', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(pharmacyEcho);
    const told: Array<[string, unknown]> = [];
    const progress = await service().pharmacyForPatients(context, [
      { patientId: patient(1), items: [{ id: order(1), status: 'active' }, { id: order(5), status: 'draft' }] },
      { patientId: patient(2), items: [{ id: order(2), status: 'active' }, { id: order(1).toUpperCase(), status: 'active' }] }],
    { onAnswer: (id, value) => told.push([id, value]) });
    expect(told.map(([id]) => id).sort()).toEqual([order(1), order(1).toUpperCase(), order(2), order(5)].sort());
    expect(new Map(told)).toEqual(progress);
    expect(progress.get(order(5))).toEqual(PHARMACY_PROGRESS_NOT_RECEIVED);
    expect(progress.get(order(1).toUpperCase())).toEqual(PHARMACY_RECEIVED);
  });
});
