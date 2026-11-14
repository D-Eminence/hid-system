import { OutreachApiClient, OutreachApiProblem, type OutreachRegistrationCase } from '@hid/api-client';

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

  it('saves a screening with PUT, the key and If-Match, and reads it (0118)', async () => {
    const caseId = '123e4567-e89b-42d3-a456-426614174004';
    const fetchMock = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ screening: null }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const client = new OutreachApiClient({ baseUrl: 'https://outreach.test' });
    await client.saveRegistrationScreening(caseId, { pulseBpm: 72 }, 2, context, 'outreach-screen-key-1234');
    await client.saveRegistrationScreening(caseId, { pulseBpm: 72 }, undefined, context, 'outreach-screen-key-5678');
    await expect(client.getRegistrationScreening(caseId, context)).resolves.toEqual({ screening: null });
    const [first, second, read] = fetchMock.mock.calls as [[string, RequestInit], [string, RequestInit], [string, RequestInit]];
    expect(first[0]).toBe(`https://outreach.test/api/v1/outreach/registration-cases/${caseId}/screening`);
    expect(first[1].method).toBe('PUT');
    expect(first[1].headers).toMatchObject({ 'idempotency-key': 'outreach-screen-key-1234', 'if-match': '"2"' });
    expect(second[1].headers).not.toHaveProperty('if-match');
    expect(read[1].method).toBe('GET');
  });

  it('sends genotype and blood group as given and reads what the service accepts (0122)', async () => {
    const caseId = '123e4567-e89b-42d3-a456-426614174004';
    const fetchMock = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ screening: null,
      accepts: ['genotype', 'bloodGroup'] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const client = new OutreachApiClient({ baseUrl: 'https://outreach.test' });
    await client.saveRegistrationScreening(caseId, { genotype: 'AS', bloodGroup: 'O-' }, undefined, context,
      'outreach-screen-key-9012');
    await expect(client.getRegistrationScreening(caseId, context))
      .resolves.toEqual({ screening: null, accepts: ['genotype', 'bloodGroup'] });
    const [save] = fetchMock.mock.calls as [[string, RequestInit]];
    expect(JSON.parse(String(save[1].body))).toEqual({ genotype: 'AS', bloodGroup: 'O-' });
  });

  it('types a registration with hasRecordedChecks and no health value (finding of 14 Nov 2026)', () => {
    const registration: Pick<OutreachRegistrationCase, 'hasScreening' | 'hasRecordedChecks'> = {
      hasScreening: true, hasRecordedChecks: false };
    // @ts-expect-error a registration carries no genotype: it is read per person, with its own audit row.
    const withGenotype: Partial<OutreachRegistrationCase> = { genotype: 'AS' };
    expect(registration.hasRecordedChecks).toBe(false);
    expect(withGenotype).toBeDefined();
  });
});
