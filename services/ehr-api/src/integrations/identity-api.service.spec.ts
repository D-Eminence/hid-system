jest.mock('../config/environment', () => ({
  getEnvironment: () => ({ IDENTITY_API_URL: 'https://identity.example.invalid' }),
}));
import type { DataAccessContext } from '../common/request-context';
import { IdentityApiService } from './identity-api.service';

const patientId = '11111111-1111-4111-8111-111111111111';
const context = {
  correlationId: 'record-read-transport-regression',
  facilityId: '22222222-2222-4222-8222-222222222222',
  membershipId: '33333333-3333-4333-8333-333333333333',
  purposeOfUse: 'direct-care',
  actor: { kind: 'staff' },
  userCookie: 'hid_session=synthetic-session',
} as DataAccessContext;
const decision = {
  allowed: true, patientId, facilityId: context.facilityId,
  membershipId: context.membershipId, scope: 'read_records',
  purpose: 'direct-care', breakGlass: false,
};

describe('Identity authorization transport for clinical reads', () => {
  let service: IdentityApiService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    service = new IdentityApiService({
      identityHeaders: async () => ({ 'x-hid-service-authorization': 'Bearer synthetic-workload' }),
    } as never);
    // Model the real Identity boundary: a cookie-authenticated internal POST
    // without browser Origin is denied, even if its workload is authenticated.
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (init?.method === 'POST' && !headers.get('origin')) {
        return Response.json({ code: 'ORIGIN_DENIED', message: 'Request origin is not allowed' }, { status: 403 });
      }
      return Response.json(decision);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('authorizes a same-origin cookie GET without inventing Origin or CSRF', async () => {
    await expect(service.authorize(patientId, 'read_records', 'direct-care', context)).resolves.toEqual(decision);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`https://identity.example.invalid/api/v1/identity/service/patients/${patientId}/record-read-authorization`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get('cookie')).toBe(context.userCookie);
    expect(headers.get('x-hid-internal-caller')).toBe('ehr-api');
    expect(headers.get('x-hid-service-authorization')).toBe('Bearer synthetic-workload');
    expect(headers.get('x-facility-id')).toBe(context.facilityId);
    expect(headers.get('x-purpose-of-use')).toBe('direct-care');
    expect(headers.get('x-correlation-id')).toBe(context.correlationId);
    expect(headers.has('origin')).toBe(false);
    expect(headers.has('x-csrf-token')).toBe(false);
  });

  it('retains denied consent decisions and rejects a decision for another patient', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...decision, allowed: false }));
    await expect(service.authorize(patientId, 'read_records', 'direct-care', context)).resolves.toMatchObject({ allowed: false });
    fetchMock.mockResolvedValueOnce(Response.json({ ...decision, patientId: context.facilityId }));
    await expect(service.authorize(patientId, 'read_records', 'direct-care', context)).rejects.toMatchObject({ status: 502 });
  });

  it('keeps cookie writes on the POST origin/CSRF boundary', async () => {
    await expect(service.authorize(patientId, 'write_records', 'direct-care', context))
      .rejects.toMatchObject({ status: 403, code: 'ORIGIN_DENIED' });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/service/authorization/check');
    fetchMock.mockResolvedValueOnce(Response.json({ ...decision, scope: 'write_records' }));
    await expect(service.authorize(patientId, 'write_records', 'direct-care', {
      ...context, origin: 'https://ehr.staging.healthidentitydirectory.com', csrfToken: 'synthetic-csrf',
    })).resolves.toMatchObject({ scope: 'write_records' });
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.get('origin')).toBe('https://ehr.staging.healthidentitydirectory.com');
    expect(headers.get('x-csrf-token')).toBe('synthetic-csrf');
  });

  it.each(['emergency', 'healthcare-operations'] as const)('does not remap %s to direct-care reads', async purpose => {
    await expect(service.authorize(patientId, 'read_records', purpose, { ...context, purposeOfUse: purpose }))
      .rejects.toMatchObject({ status: 403, code: 'ORIGIN_DENIED' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/service/authorization/check');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ purpose, scope: 'read_records' });
  });
});
