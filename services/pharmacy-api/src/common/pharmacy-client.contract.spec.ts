import { PharmacyApiClient, PharmacyApiProblem } from '@hid/api-client';

const context = {
  authorization: 'Bearer propagated-user', correlationId: 'client-contract-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001', purposeOfUse: 'direct-care',
};

describe('PharmacyApiClient transport contract', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('keeps user and workload credentials separate and retries one transient idempotent failure', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporarily unavailable' }),
        { status: 503, headers: { 'content-type': 'application/problem+json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123e4567-e89b-42d3-a456-426614174002' }),
        { status: 201, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const workload = jest.fn()
      .mockResolvedValueOnce('Bearer pharmacy-workload-one')
      .mockResolvedValueOnce('Bearer pharmacy-workload-two');
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test',
      serviceAuthorizationProvider: workload });
    await expect(client.acceptEhrPrescription({ sourceStatus: 'active' }, context,
      'pharmacy-client-key-1234')).resolves.toEqual({ id: '123e4567-e89b-42d3-a456-426614174002' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(workload).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const retry = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: 'Bearer propagated-user',
      'x-hid-service-authorization': 'Bearer pharmacy-workload-one',
      'x-hid-internal-caller': 'ehr-api', 'idempotency-key': 'pharmacy-client-key-1234' });
    expect(retry.headers).toMatchObject({ authorization: 'Bearer propagated-user',
      'x-hid-service-authorization': 'Bearer pharmacy-workload-two',
      'x-hid-internal-caller': 'ehr-api', 'idempotency-key': 'pharmacy-client-key-1234' });
    expect(request.headers).not.toHaveProperty('x-hid-service-token');
  });

  it('does not retry a domain conflict and preserves Problem Details', async () => {
    const payload = { code: 'IDEMPOTENCY_CONFLICT', detail: 'Key belongs to another request' };
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
      { status: 409, headers: { 'content-type': 'application/problem+json' } }));
    global.fetch = fetchMock;
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test',
      internalServiceToken: 'local-pharmacy-service-token-123456' });
    await expect(client.createOcrImport({}, context, 'pharmacy-client-key-1234'))
      .rejects.toMatchObject<Partial<PharmacyApiProblem>>({ status: 409, payload });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads one patient\'s imported medications as a browser GET with patientId, limit and cursor in the query', async () => {
    const record = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
      facilityId: context.facilityId, sourceType: 'IMPORTED_MEDICATION_EVIDENCE', activityStatus: 'unknown',
      medicationText: 'Fictional medicine', strengthText: null, doseText: null, frequencyText: null,
      historicalContext: null, sourceDocumentId: '123e4567-e89b-42d3-a456-426614174005',
      ocrJobId: '123e4567-e89b-42d3-a456-426614174006', extractionId: '123e4567-e89b-42d3-a456-426614174007',
      validationId: '123e4567-e89b-42d3-a456-426614174008', validationVersion: 1,
      publicationId: '123e4567-e89b-42d3-a456-426614174009', version: 1, createdAt: '2026-11-05T10:00:00.000Z' };
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify({ items: [record], nextCursor: record.id }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });
    await expect(client.listImportedMedicationEvidence(record.patientId, context, { limit: 20, cursor: record.id }))
      .resolves.toEqual({ items: [record], nextCursor: record.id });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://pharmacy.test/api/v1/pharmacy/imports?patientId=${
      record.patientId}&limit=20&cursor=${record.id}`);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('GET');
    expect(request.headers).not.toHaveProperty('x-hid-internal-caller');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [record] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(client.listImportedMedicationEvidence(record.patientId, context))
      .rejects.toMatchObject({ status: 502 });
  });
});
