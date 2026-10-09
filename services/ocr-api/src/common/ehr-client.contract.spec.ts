import { EhrApiClient, EhrApiProblem } from '@hid/api-client';

const context = {
  correlationId: 'ocr-ehr-contract-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001',
  purposeOfUse: 'direct-care',
  cookie: 'hid_access=session-token; hid_access_csrf=csrf-cookie',
  csrfToken: 'csrf-cookie',
  origin: 'https://ehr.test',
};

describe('EhrApiClient OCR transport contract', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('keeps user and workload evidence separate on the exact source boundary without retrying GET', async () => {
    const source = { id: '123e4567-e89b-42d3-a456-426614174002',
      patientId: '123e4567-e89b-42d3-a456-426614174003', facilityId: context.facilityId,
      objectVersionId: 'version-1', sha256Hex: 'a'.repeat(64), status: 'available', scanStatus: 'clean' };
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(source),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const workload = jest.fn().mockResolvedValue('Bearer ehr-workload-one');
    const client = new EhrApiClient({ baseUrl: 'https://ehr.test', serviceAuthorizationProvider: workload });

    await expect(client.getOcrDocumentSource(source.id, context)).resolves.toEqual(source);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workload).toHaveBeenCalledWith('ocr-api');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://ehr.test/api/v1/ehr/internal/ocr/documents/${source.id}/source`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      cookie: context.cookie, 'x-csrf-token': context.csrfToken, origin: context.origin,
      'x-hid-service-authorization': 'Bearer ehr-workload-one',
      'x-hid-internal-caller': 'ocr-api', 'x-correlation-id': context.correlationId,
    });
  });

  it('refreshes workload evidence for one bounded idempotent publication retry', async () => {
    const resourceId = '123e4567-e89b-42d3-a456-426614174009';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporarily unavailable' }),
        { status: 503, headers: { 'content-type': 'application/problem+json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: resourceId }),
        { status: 201, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const workload = jest.fn()
      .mockResolvedValueOnce('Bearer ehr-workload-one')
      .mockResolvedValueOnce('Bearer ehr-workload-two');
    const client = new EhrApiClient({ baseUrl: 'https://ehr.test', serviceAuthorizationProvider: workload });
    const publicationId = '123e4567-e89b-42d3-a456-426614174004';
    const input = { encounterId: '123e4567-e89b-42d3-a456-426614174005', noteType: 'progress',
      title: 'Imported review', content: 'Reviewed OCR content', publicationId,
      documentId: '123e4567-e89b-42d3-a456-426614174006',
      ocrJobId: '123e4567-e89b-42d3-a456-426614174007',
      extractionId: '123e4567-e89b-42d3-a456-426614174008',
      validationId: '123e4567-e89b-42d3-a456-42661417400a', validationVersion: 1,
      reviewedBy: 'staff:reviewer' };
    const patientId = '123e4567-e89b-42d3-a456-42661417400b';

    await expect(client.createOcrClinicalNote(patientId, input, context,
      `ocr-publication:${publicationId}`)).resolves.toEqual({ id: resourceId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(workload).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://ehr.test/api/v1/ehr/internal/ocr/patients/${patientId}/clinical-notes`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'x-hid-service-authorization': 'Bearer ehr-workload-one',
      'idempotency-key': `ocr-publication:${publicationId}`,
      'x-correlation-id': context.correlationId,
    });
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      'x-hid-service-authorization': 'Bearer ehr-workload-two',
      'idempotency-key': `ocr-publication:${publicationId}`,
    });
  });

  it('does not retry a domain conflict and preserves Problem Details', async () => {
    const payload = { code: 'IDEMPOTENCY_CONFLICT', detail: 'Publication key has another digest' };
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
      { status: 409, headers: { 'content-type': 'application/problem+json' } }));
    global.fetch = fetchMock;
    const client = new EhrApiClient({ baseUrl: 'https://ehr.test',
      internalServiceToken: 'local-ehr-service-token-123456789' });
    await expect(client.createOcrClinicalNote('patient-id', {} as never, context,
      'ocr-publication:stable-key')).rejects.toMatchObject<Partial<EhrApiProblem>>({ status: 409, payload });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
