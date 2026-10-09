import { OutreachApiClient, OutreachApiProblem } from '@hid/api-client';

const context = { correlationId: 'client-contract-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001', purposeOfUse: 'direct-care' as const,
  csrfToken: 'opaque-csrf-token' };
const input = { localCommandId: '123e4567-e89b-42d3-a456-426614174002',
  temporaryPatientId: 'tmp_123e4567-e89b-42d3-a456-426614174003',
  fullName: 'Ada Person', sex: 'unknown' as const, ageYears: 30 };

describe('OutreachApiClient transport contract', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('retries one transient idempotent command with the same context and key', async () => {
    const result = { id: '123e4567-e89b-42d3-a456-426614174004', ...input,
      facilityId: context.facilityId, status: 'identity_resolution_pending', phone: null,
      operationalNotes: null, resolvedPatientId: null, resolutionKind: null,
      rowVersion: 1, createdAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:00:00.000Z' };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporarily unavailable' }),
        { status: 503, headers: { 'content-type': 'application/problem+json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(result),
        { status: 201, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const client = new OutreachApiClient({ baseUrl: 'https://outreach.test' });
    await expect(client.createRegistrationCase(input, context, 'outreach-client-key-1234'))
      .resolves.toMatchObject({ id: result.id, temporaryPatientId: input.temporaryPatientId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).headers).toMatchObject({
        'idempotency-key': 'outreach-client-key-1234',
        'x-facility-id': context.facilityId, 'x-purpose-of-use': 'direct-care',
        'x-csrf-token': 'opaque-csrf-token',
      });
    }
  });

  it('does not retry a version conflict', async () => {
    const payload = { code: 'VERSION_CONFLICT', detail: 'Reload before reconciling' };
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
      { status: 412, headers: { 'content-type': 'application/problem+json' } }));
    global.fetch = fetchMock;
    const client = new OutreachApiClient({ baseUrl: 'https://outreach.test' });
    await expect(client.linkExistingPatient('123e4567-e89b-42d3-a456-426614174004', {
      canonicalPatientId: '123e4567-e89b-42d3-a456-426614174005', expectedVersion: 1,
      reason: 'Exact existing Identity match was reviewed',
    }, context, 'outreach-link-key-1234')).rejects.toMatchObject<Partial<OutreachApiProblem>>({
      status: 412, code: 'VERSION_CONFLICT', retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
