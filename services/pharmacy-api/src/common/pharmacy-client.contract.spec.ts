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

  // 0113: an own work item may carry its patient (OWN_WORK_PATIENT_CARD_ENABLED on); the client keeps it, and
  // answers exactly as before when it is absent.
  it('keeps a work item\'s optional patient, and leaves it out when absent', async () => {
    const base = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
      facilityId: context.facilityId, sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174005',
      sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', sourceEhrPrescriptionVersion: 1, status: 'accepted',
      medication: { codeSystem: null, code: null, display: 'Amoxicillin 500 mg capsule' }, doseQuantity: 1,
      doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
      acceptedAt: '2026-11-01T09:00:00.000Z', version: 1, dispensing: null };
    const patient = { fullName: 'Amaka Card', sex: null, dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ ...base, patient }, base] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });
    const [own, plain] = await client.listWorkItems(context);
    expect(own?.patient).toEqual(patient);
    expect(plain).not.toHaveProperty('patient');
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ ...base, patient: { sex: 'female' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(client.getWorkItem(base.id, context)).rejects.toMatchObject({ status: 502 });
  });
});
