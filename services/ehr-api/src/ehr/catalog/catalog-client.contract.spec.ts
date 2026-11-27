import { EhrApiClient, EhrApiProblem, type EhrStaffRequestContext } from '@hid/api-client';
import { facilityItem } from './facility-items.service';

// ORD-7 (0155): @hid/api-client's catalogue calls against the answers ehr-api's services build. Fictional values only.
const context: EhrStaffRequestContext = {
  correlationId: 'catalog-client-contract-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001',
  cookie: 'hid_access=session-token; hid_access_csrf=csrf-cookie',
  csrfToken: 'csrf-cookie',
  origin: 'https://ehr.test',
};
const itemId = '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c01';
const medicine = facilityItem({ id: itemId, kind: 'medicine', display: 'Artemether + lumefantrine 20/120 mg dispersible tablet',
  generic_name: 'Artemether + lumefantrine', strength: '20/120 mg', dose_form: 'tablet', routes: ['oral'], specimen: null,
  category: null, active: true, row_version: '1', created_at: new Date('2026-11-26T09:00:00.000Z'), changed_at: null });
const labTest = facilityItem({ id: '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c02', kind: 'lab_test', display: 'Malaria RDT (own kit)',
  generic_name: null, strength: null, dose_form: null, routes: [], specimen: null, category: null, active: false,
  row_version: '2', created_at: new Date('2026-11-26T09:00:00.000Z'), changed_at: new Date('2026-11-26T10:00:00.000Z') });

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' } });

describe('EhrApiClient catalogue calls (ORD-7, 0155)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const client = () => new EhrApiClient({ baseUrl: 'https://ehr.test' });
  const call = (fetchMock: jest.Mock, index = 0) => ({ url: fetchMock.mock.calls[index]?.[0] as string,
    init: fetchMock.mock.calls[index]?.[1] as RequestInit & { headers: Record<string, string> } });

  it('reads the status as the staff member at this facility: no purpose of use, no internal-caller headers', async () => {
    const status = { medicines: { available: true, version: null, approvedAt: null, fileSha256: null },
      labTests: { available: false, version: null, approvedAt: null, fileSha256: null },
      diagnoses: { available: false, release: null, fileSha256: null }, labTestNameOnly: false, diagnosisNameOnly: false,
      classDuplicateCheck: false, attribution: [] };
    const fetchMock = jest.fn().mockResolvedValue(answer(200, status));
    global.fetch = fetchMock;
    await expect(client().getCatalogStatus(context)).resolves.toEqual(status);
    const { url, init } = call(fetchMock);
    expect([url, init.method, init.credentials]).toEqual(['https://ehr.test/api/v1/ehr/catalog/status', 'GET', 'include']);
    expect(init.headers).toMatchObject({ 'x-facility-id': context.facilityId, 'x-correlation-id': context.correlationId,
      cookie: context.cookie, 'x-csrf-token': context.csrfToken, origin: context.origin });
    for (const header of ['x-purpose-of-use', 'x-hid-internal-caller', 'x-hid-service-token', 'idempotency-key']) {
      expect(Object.keys(init.headers)).not.toContain(header);
    }
  });

  it('searches with q and the filters in the query, and reads national and facility items alike', async () => {
    const national = { codeSystem: 'HID-MED', code: 'MED-00001', display: 'Artemether + lumefantrine 20/120 mg tablet',
      genericName: 'artemether + lumefantrine', strength: '20/120 mg', doseForm: 'tablet', doseFormText: 'Tablet',
      routes: ['oral'], atcCode: null, commonAdultDose: null, matchedName: null, scope: 'national', source: 'nigeria-eml-8' };
    const own = { codeSystem: medicine.codeSystem, code: medicine.code, display: medicine.display,
      genericName: 'Artemether + lumefantrine', strength: '20/120 mg', doseForm: 'tablet', doseFormText: null, routes: ['oral'],
      atcCode: null, commonAdultDose: null, matchedName: null, scope: 'facility', source: 'facility' };
    const fetchMock = jest.fn().mockResolvedValue(answer(200, { listVersion: '2026.1', more: false, items: [national, own] }));
    global.fetch = fetchMock;
    await expect(client().searchCatalogMedicines({ q: 'artem lum', limit: 5, doseForm: 'tablet', route: 'oral' }, context))
      .resolves.toEqual({ listVersion: '2026.1', more: false, items: [national, own] });
    expect(call(fetchMock).url).toBe('https://ehr.test/api/v1/ehr/catalog/medicines?q=artem+lum&limit=5&doseForm=tablet&route=oral');
  });

  it('searches lab tests, a facility test with no category or specimen', async () => {
    const own = { codeSystem: 'HID-FACILITY', code: labTest.code, display: labTest.display, otherNames: [], specimen: null,
      category: null, matchedName: null, scope: 'facility' };
    const fetchMock = jest.fn().mockResolvedValue(answer(200, { listVersion: null, more: true, items: [own] }));
    global.fetch = fetchMock;
    await expect(client().searchCatalogLabTests({ q: 'malaria' }, context))
      .resolves.toEqual({ listVersion: null, more: true, items: [own] });
    expect(call(fetchMock).url).toBe('https://ehr.test/api/v1/ehr/catalog/lab-tests?q=malaria');
  });

  it('lists this facility\'s items as ehr-api answers them', async () => {
    const fetchMock = jest.fn().mockResolvedValue(answer(200, { items: [labTest, medicine], more: false }));
    global.fetch = fetchMock;
    await expect(client().listFacilityItems(context, 'lab_test')).resolves.toEqual({ items: [labTest, medicine], more: false });
    expect(call(fetchMock).url).toBe('https://ehr.test/api/v1/ehr/catalog/facility-items?kind=lab_test');
    global.fetch = jest.fn().mockResolvedValue(answer(200, { items: [], more: false }));
    await client().listFacilityItems(context);
    expect(call(global.fetch as jest.Mock).url).toBe('https://ehr.test/api/v1/ehr/catalog/facility-items');
  });

  it('adds an item with its Idempotency-Key, tried once more on 503 with the same key', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(answer(503, { code: 'CATALOG_UNAVAILABLE' }))
      .mockResolvedValueOnce(answer(201, medicine));
    global.fetch = fetchMock;
    const input = { kind: 'medicine' as const, display: medicine.display, genericName: 'Artemether + lumefantrine',
      strength: '20/120 mg', doseForm: 'tablet' as const, routes: ['oral'] };
    await expect(client().createFacilityItem(input, context, 'facility-item-key-0001')).resolves.toEqual(medicine);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      const { url, init } = call(fetchMock, index);
      expect([url, init.method, JSON.parse(String(init.body)), init.headers['idempotency-key']]).toEqual([
        'https://ehr.test/api/v1/ehr/catalog/facility-items', 'POST', input, 'facility-item-key-0001']);
    }
  });

  it.each([
    [409, 'FACILITY_ITEM_EXISTS'], [409, 'FACILITY_ITEM_LIMIT'], [409, 'IDEMPOTENCY_KEY_REUSED'], [403, 'PERMISSION_DENIED'],
    [400, 'VALIDATION_FAILED'],
  ])('an add refused %i %s is not retried, and keeps the problem', async (status, code) => {
    const fetchMock = jest.fn().mockResolvedValue(answer(status, { code, detail: 'Refused' }));
    global.fetch = fetchMock;
    const refusal = client().createFacilityItem({ kind: 'lab_test', display: 'Sickling test' }, context, 'facility-item-key-0002');
    await expect(refusal).rejects.toBeInstanceOf(EhrApiProblem);
    await expect(refusal).rejects.toMatchObject({ status, payload: { code } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('withdraws an item with PATCH and never retries it (a retry after success would be 412)', async () => {
    const withdrawn = { ...medicine, active: false, rowVersion: 2, changedAt: '2026-11-26T10:00:00.000Z' };
    const fetchMock = jest.fn().mockResolvedValue(answer(200, withdrawn));
    global.fetch = fetchMock;
    await expect(client().updateFacilityItem(itemId, { expectedRowVersion: 1, active: false }, context)).resolves.toEqual(withdrawn);
    expect([call(fetchMock).url, call(fetchMock).init.method, JSON.parse(String(call(fetchMock).init.body))]).toEqual([
      `https://ehr.test/api/v1/ehr/catalog/facility-items/${itemId}`, 'PATCH', { expectedRowVersion: 1, active: false }]);
    const busy = jest.fn().mockResolvedValue(answer(503, { code: 'CATALOG_UNAVAILABLE' }));
    global.fetch = busy;
    await expect(client().updateFacilityItem(itemId, { expectedRowVersion: 2, active: true }, context))
      .rejects.toMatchObject({ status: 503 });
    expect(busy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an item whose code is not its id', { ...medicine, code: 'MED-00001' }],
    ['an item of another code system', { ...medicine, codeSystem: 'HID-MED' }],
    ['an item of another kind', { ...medicine, kind: 'device' }],
    ['a row version that is not a whole number', { ...medicine, rowVersion: '1' }],
    ['an unknown dose form', { ...medicine, doseForm: 'pessary' }],
  ])('refuses %s as 502', async (_name, body) => {
    global.fetch = jest.fn().mockResolvedValue(answer(200, body));
    await expect(client().updateFacilityItem(itemId, { expectedRowVersion: 1, active: false }, context))
      .rejects.toMatchObject({ status: 502 });
  });
});
