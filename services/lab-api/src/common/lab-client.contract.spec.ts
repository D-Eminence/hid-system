import { LabApiClient, LabApiProblem } from '@hid/api-client';

const bearerContext = {
  authorization: 'Bearer propagated-user', correlationId: 'lab-client-contract-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001', purposeOfUse: 'direct-care',
};

describe('LabApiClient transport contract', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('keeps cookie user evidence separate and refreshes workload evidence for one bounded retry', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporarily unavailable' }),
        { status: 503, headers: { 'content-type': 'application/problem+json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123e4567-e89b-42d3-a456-426614174002' }),
        { status: 201, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const workload = jest.fn()
      .mockResolvedValueOnce('Bearer lab-workload-one')
      .mockResolvedValueOnce('Bearer lab-workload-two');
    const client = new LabApiClient({ baseUrl: 'https://lab.test',
      serviceAuthorizationProvider: workload });
    const context = { correlationId: 'lab-client-contract-1234',
      facilityId: bearerContext.facilityId, purposeOfUse: 'direct-care',
      cookie: 'hid_access=session-token; hid_access_csrf=csrf-cookie',
      csrfToken: 'csrf-cookie', origin: 'https://ehr.test' };

    await expect(client.createOcrImport({}, context, 'lab-client-key-1234'))
      .resolves.toEqual({ id: '123e4567-e89b-42d3-a456-426614174002' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(workload).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(first.headers).toMatchObject({ cookie: context.cookie,
      'x-csrf-token': 'csrf-cookie', origin: 'https://ehr.test',
      'x-hid-service-authorization': 'Bearer lab-workload-one',
      'x-hid-internal-caller': 'ocr-api', 'idempotency-key': 'lab-client-key-1234',
      'x-correlation-id': 'lab-client-contract-1234' });
    expect(first.headers).not.toHaveProperty('authorization');
    expect(second.headers).toMatchObject({
      'x-hid-service-authorization': 'Bearer lab-workload-two',
      'idempotency-key': 'lab-client-key-1234', 'x-correlation-id': 'lab-client-contract-1234' });
  });

  it('does not retry a domain conflict and preserves Problem Details', async () => {
    const payload = { code: 'IDEMPOTENCY_CONFLICT', detail: 'Key belongs to another request' };
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
      { status: 409, headers: { 'content-type': 'application/problem+json' } }));
    global.fetch = fetchMock;
    const client = new LabApiClient({ baseUrl: 'https://lab.test',
      internalServiceToken: 'local-lab-service-token-123456' });
    await expect(client.acceptEhrOrder({}, bearerContext, 'lab-client-key-1234'))
      .rejects.toMatchObject<Partial<LabApiProblem>>({ status: 409, payload });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails after the bounded retry instead of reporting dependency success', async () => {
    const fetchMock = jest.fn().mockImplementation(async () => new Response('temporarily unavailable',
      { status: 503, headers: { 'content-type': 'text/plain' } }));
    global.fetch = fetchMock;
    const client = new LabApiClient({ baseUrl: 'https://lab.test',
      internalServiceToken: 'local-lab-service-token-123456' });
    await expect(client.acceptEhrOrder({}, bearerContext, 'lab-client-key-1234'))
      .rejects.toMatchObject<Partial<LabApiProblem>>({ status: 503, payload: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
