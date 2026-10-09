import { IdentityApiClient, IdentityApiProblem } from '@hid/api-client';

describe('IdentityApiClient boundary', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('keeps user delegation, workload identity, facility, purpose, and correlation distinct', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      allowed: true,
      patientId: '50000000-0000-4000-8000-000000000001',
      facilityId: '10000000-0000-4000-8000-000000000002',
      membershipId: '40000000-0000-4000-8000-000000000001',
      scope: 'read_records',
      purpose: 'direct-care',
      breakGlass: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const client = new IdentityApiClient({ baseUrl: 'https://identity.example', caller: 'lab-api',
      workloadHeaders: async () => ({ 'x-hid-service-authorization': 'Bearer workload-token' }) });

    await client.authorizePatient('50000000-0000-4000-8000-000000000001',
      'read_records', 'direct-care', {
        correlationId: 'correlation-identity-client-0001',
        facilityId: '10000000-0000-4000-8000-000000000002',
        authorization: 'Bearer user-token',
      });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://identity.example/api/v1/identity/service/authorization/check',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer user-token',
          'x-hid-internal-caller': 'lab-api',
          'x-hid-service-authorization': 'Bearer workload-token',
          'x-correlation-id': 'correlation-identity-client-0001',
          'x-facility-id': '10000000-0000-4000-8000-000000000002',
          'x-purpose-of-use': 'direct-care',
        }),
      }),
    );
  });

  it('uses Identity mutation validation for delegated cookie mutations', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ actor: {
      id: 'account-1', subject: 'staff:one', accountId: 'account-1', roles: [], permissions: [],
      facilityIds: [], facilities: [], authenticationMethod: 'local',
    } }), { status: 200 }));
    const client = new IdentityApiClient({ baseUrl: 'https://identity.example', caller: 'ehr-api',
      workloadHeaders: async () => ({ 'x-hid-service-token': 'development-only-token' }) });
    await client.authenticateActor({ correlationId: 'correlation-cookie-mutation-0001',
      cookie: 'hid_access=opaque; hid_access_csrf=csrf', csrfToken: 'csrf',
      origin: 'https://app.example', validateMutation: true });
    expect(global.fetch).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({ method: 'POST' }));
  });

  it('preserves Problem Details status and code across the network boundary', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 403, code: 'FACILITY_ACCESS_DENIED', detail: 'Facility access was denied',
    }), { status: 403 }));
    const client = new IdentityApiClient({ baseUrl: 'https://identity.example', caller: 'ehr-api',
      workloadHeaders: async () => ({ 'x-hid-service-token': 'development-only-token' }) });
    await expect(client.authenticateActor({ correlationId: 'correlation-problem-0001',
      authorization: 'Bearer user-token' })).rejects.toMatchObject<Partial<IdentityApiProblem>>({
        status: 403, code: 'FACILITY_ACCESS_DENIED', message: 'Facility access was denied',
      });
  });

  it('keeps raw NIN out of the URL and retries an idempotent registration at most once', async () => {
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        caseId: 'a1000000-0000-4000-8000-000000000001',
        status: 'review_required', version: 1, candidateCount: 2,
      }), { status: 200 }));
    global.fetch = fetchMock;
    const client = new IdentityApiClient({ baseUrl: 'https://identity.example', caller: 'ehr-api',
      workloadHeaders: async () => ({ 'x-hid-service-authorization': 'Bearer workload-token' }) });
    await client.resolveNin({ nin: '12345678901', firstName: 'Amina', lastName: 'Okafor',
      dateOfBirth: '1990-01-02', purpose: 'healthcare-operations' },
    'identity-registration-command-0001', {
      correlationId: 'correlation-registration-0001',
      facilityId: '10000000-0000-4000-8000-000000000002',
      authorization: 'Bearer user-token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('12345678901');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ 'idempotency-key': 'identity-registration-command-0001' }),
      body: expect.stringContaining('12345678901'),
    }));
  });
});
