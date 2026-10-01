import { DomainProblem } from '../common/problem';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';

const configuration = {
  baseUrl: 'https://api.qoreid.com',
  clientId: 'server-only-client-id',
  clientSecret: 'server-only-client-secret',
  timeoutMs: 500,
};

const token = { accessToken: 'server-only-access-token', expiresIn: 7200, tokenType: 'Bearer' };
const claims = { firstName: 'Samplefirst', lastName: 'Samplelast', dateOfBirth: '1991-03-04' };
const complete = {
  id: 48291,
  status: { state: 'complete', status: 'verified' },
  summary: { nin_check: { status: 'EXACT_MATCH', fieldMatches: { firstname: true, lastname: true } } },
  nin: { nin: '12345678901', firstname: 'Samplefirst', lastname: 'Samplelast', birthdate: '04-03-1991',
    photo: 'sensitive-photo', address: 'sensitive-address' },
};
// The NIN-only fields and nesting follow the entitled sandbox observation,
// including its numeric top-level provider id. All fixture values are invented.
const fixtureNin = '00000000000';
const fixtureResidence = {
  address1: 'Fixture Address 1', town: 'Fixture Town', lga: 'Fixture LGA', state: 'Fixture State',
};
const sandboxNinOnlySuccess = {
  id: 48291,
  status: { state: 'complete', status: 'verified' },
  summary: { nin_check: 'verified' },
  nin: {
    nin: fixtureNin, firstname: 'Fixture', lastname: 'Person', middlename: 'Sample',
    phone: '00000000000', gender: 'F', photo: 'Zml4dHVyZQ==', birthdate: '01-01-1990',
    residence: fixtureResidence,
  },
};
const enrollmentConfiguration = {
  ...configuration,
  ninOnlyEnrollmentEnabled: true,
};

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('QoreID verification adapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses QoreID OAuth fields and submits canonical name and DOB claims for NIN', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response(complete));
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);

    await expect(adapter.verifyNin('12345678901', claims)).resolves.toEqual({
      provider: 'qoreid', state: 'verified', providerReference: '48291', respondedAt: expect.any(String),
      ninBinding: { firstName: 'Samplefirst', lastName: 'Samplelast', dateOfBirth: '1991-03-04' },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]).toEqual([
      'https://api.qoreid.com/token',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ clientId: 'server-only-client-id', secret: 'server-only-client-secret' }),
      }),
    ]);
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.qoreid.com/v1/ng/identities/nin/12345678901');
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetch.mock.calls[1]?.[1]?.redirect).toBe('error');
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({
      firstname: 'Samplefirst', lastname: 'Samplelast', dob: '1991-03-04',
    }));
    const ninHeaders = fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(ninHeaders).toEqual({ accept: 'application/json', authorization: 'Bearer server-only-access-token',
      'content-type': 'application/json' });
  });

  it.each(['RC1234', 'BN1234', 'IT1234'])
  ('blocks CAC verification before OAuth or registry requests while entitlement and mapping are unconfirmed: %s', async (number) => {
    const fetch = jest.fn();
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyCac(number)).rejects.toMatchObject({
      status: 503, code: 'QOREID_CAC_CONTRACT_UNCONFIRMED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['1234', 'RC-1234', 'CO1234', 'RC123', `RC${'1'.repeat(21)}`])
  ('rejects malformed CAC identifiers before any provider request: %s', async (number) => {
    const fetch = jest.fn();
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyCac(number)).rejects.toMatchObject({
      status: 400, code: 'CAC_REGISTRATION_NUMBER_INVALID',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps NIN-only enrollment disabled by configuration before any provider request', async () => {
    const fetch = jest.fn();
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment('12345678901')).rejects.toMatchObject({
      status: 503, code: 'QOREID_NIN_ONLY_DISABLED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts the observed sandbox NIN-only shape and sends a body-free request', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response(sandboxNinOnlySuccess));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment(fixtureNin)).resolves.toMatchObject({
      state: 'verified', providerReference: '48291', ninEnrollmentBinding: {
        nin: fixtureNin, firstName: 'Fixture', lastName: 'Person', middleName: 'Sample',
        dateOfBirth: '1990-01-01', gender: 'female', phoneNumber: '00000000000',
        photo: 'Zml4dHVyZQ==', address: 'Fixture Address 1',
        residence: { address1: 'Fixture Address 1', town: 'Fixture Town',
          lga: 'Fixture LGA', state: 'Fixture State' },
      },
    });
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.qoreid.com/v1/ng/identities/nin/00000000000');
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty('body');
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual({
      accept: 'application/json', authorization: 'Bearer server-only-access-token',
    });
  });

  it('does not map a top-level-only residence as authoritative identity', async () => {
    const payload = { ...sandboxNinOnlySuccess,
      nin: { ...sandboxNinOnlySuccess.nin, residence: undefined }, residence: fixtureResidence };
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    const result = await adapter.verifyNinEnrollment(fixtureNin);
    expect(result.state).toBe('verified');
    expect(result.ninEnrollmentBinding).not.toHaveProperty('address');
    expect(result.ninEnrollmentBinding).not.toHaveProperty('residence');
  });

  it('uses nested residence even when an unrelated top-level field differs', async () => {
    const payload = { ...sandboxNinOnlySuccess,
      residence: { ...fixtureResidence, address1: 'Untrusted top-level address' } };
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment(fixtureNin)).resolves.toMatchObject({
      state: 'verified', ninEnrollmentBinding: { residence: fixtureResidence },
    });
  });

  it.each(['1234567890', '123456789012', '1234567890A', '1234567890 ', ''])
  ('rejects malformed enrollment NIN before a provider request: %j', async (nin) => {
    const fetch = jest.fn();
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment(nin)).rejects.toMatchObject({ status: 400, code: 'NIN_INVALID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts core identity when optional middle name, phone, residence, and photo are absent', async () => {
    const payload = { ...sandboxNinOnlySuccess, residence: undefined, nin: {
      nin: fixtureNin, firstname: 'Fixture', lastname: 'Person', birthdate: '01-01-1990', gender: 'female',
    } };
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    const result = await adapter.verifyNinEnrollment(fixtureNin);
    expect(result).toMatchObject({
      state: 'verified', ninEnrollmentBinding: { nin: fixtureNin, firstName: 'Fixture',
        lastName: 'Person', dateOfBirth: '1990-01-01', gender: 'female' },
    });
    expect(result.ninEnrollmentBinding).not.toHaveProperty('middleName');
    expect(result.ninEnrollmentBinding).not.toHaveProperty('phoneNumber');
    expect(result.ninEnrollmentBinding).not.toHaveProperty('address');
    expect(result.ninEnrollmentBinding).not.toHaveProperty('residence');
    expect(result.ninEnrollmentBinding).not.toHaveProperty('photo');
  });

  it.each([null, ''])('accepts a blank optional middle name: %j', async (middlename) => {
    const payload = { ...sandboxNinOnlySuccess, nin: { ...sandboxNinOnlySuccess.nin, middlename } };
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    const result = await adapter.verifyNinEnrollment(fixtureNin);
    expect(result.ninEnrollmentBinding).not.toHaveProperty('middleName');
  });

  it.each([undefined, null, '48291', -1, 1.25, Number.MAX_SAFE_INTEGER + 1])
  ('rejects a missing or non-numeric safe provider id: %j', async (id) => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ ...sandboxNinOnlySuccess, id }));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment(fixtureNin)).rejects.toMatchObject({
      code: 'QOREID_PROVIDER_RESPONSE_INVALID', status: 502,
    });
  });

  it('rejects a NIN-only response with a mismatched NIN or malformed authoritative identity', async () => {
    const full = sandboxNinOnlySuccess;
    for (const payload of [
      { ...full, nin: { ...full.nin, nin: '11111111111' } },
      { ...full, nin: { ...full.nin, nin: undefined } },
      { ...full, nin: { ...full.nin, firstname: undefined } },
      { ...full, nin: { ...full.nin, lastname: undefined } },
      { ...full, nin: { ...full.nin, birthdate: undefined } },
      { ...full, nin: { ...full.nin, gender: undefined } },
      { ...full, nin: { ...full.nin, middlename: 123 } },
      { ...full, nin: { ...full.nin, middlename: 'Bad\nName' } },
      { ...full, nin: { ...full.nin, phone: '' } },
      { ...full, nin: { ...full.nin, photo: 'bad base64?' } },
      { ...full, nin: { ...full.nin, residence: { ...fixtureResidence, address1: '' } } },
      { ...full, nin: { ...full.nin, residence: { ...fixtureResidence, town: 'Bad\nTown' } } },
      { ...full, nin: { ...full.nin, residence: { ...fixtureResidence, lga: 123 } } },
      { ...full, nin: { ...full.nin, residence: { ...fixtureResidence, state: '' } } },
      { ...full, nin: { ...full.nin, residence: [] } },
    ]) {
      const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
      const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
        fetch as unknown as typeof globalThis.fetch);
      await expect(adapter.verifyNinEnrollment(fixtureNin)).rejects.toMatchObject({
        code: 'QOREID_PROVIDER_RESPONSE_INVALID',
      });
    }
  });

  it.each([
    { status: { state: 'complete', status: 'declined' } },
    { status: { state: 'pending', status: 'queued' } },
    { summary: { nin_check: 'declined' } },
  ])('does not enroll an unverified NIN-only provider result', async (override) => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response({
      ...sandboxNinOnlySuccess, ...override,
    }));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    const result = await adapter.verifyNinEnrollment(fixtureNin);
    expect(result.state).not.toBe('verified');
    expect(result.ninEnrollmentBinding).toBeUndefined();
  });

  it.each([
    { status: { status: 'verified' } },
    { summary: undefined },
    { summary: 'malformed' },
    { summary: {} },
    { summary: { nin_check: { status: 'EXACT_MATCH' } } },
    { summary: { nin_check: null } },
  ])('rejects malformed NIN-only provider evidence', async (override) => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response({
      ...sandboxNinOnlySuccess, ...override,
    }));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment(fixtureNin)).rejects.toMatchObject({
      code: 'QOREID_PROVIDER_RESPONSE_INVALID', status: 502,
    });
  });

  it.each([
    [{ id: 1, status: { state: 'pending', status: 'queued' } }, 'incomplete'],
    [{ id: 1, status: { state: 'complete', status: 'declined' } }, 'not_verified'],
  ] as const)('never treats a non-verified provider state as verified', async (payload, state) => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNin('12345678901', claims)).resolves.toMatchObject({ state });
  });

  it('does not accept status verified when the NIN name match is partial', async () => {
    const payload = { ...complete, summary: { nin_check: { status: 'PARTIAL_MATCH',
      fieldMatches: { firstname: true, lastname: false } } } };
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
    const result = await new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch)
      .verifyNin('12345678901', claims);
    expect(result.state).toBe('not_verified');
    expect(result.ninBinding).toBeUndefined();
  });

  it('rejects an explicit DOB mismatch even when the transaction and name match are verified', async () => {
    const payload = { ...complete, summary: { nin_check: { status: 'EXACT_MATCH',
      fieldMatches: { firstname: true, lastname: true, dob: false } } } };
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
    await expect(new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch)
      .verifyNin('12345678901', claims)).resolves.toMatchObject({ state: 'not_verified' });
  });

  it('does not bind the logged-in patient when returned NIN or DOB differs', async () => {
    for (const changed of [{ ...complete.nin, nin: '99999999999' },
      { ...complete.nin, birthdate: '07-01-1974' }]) {
      const fetch = jest.fn().mockResolvedValueOnce(response(token))
        .mockResolvedValueOnce(response({ ...complete, nin: changed }));
      await expect(new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch)
        .verifyNin('12345678901', claims)).resolves.toMatchObject({ state: 'not_verified' });
    }
  });

  it('rejects a verified provider status with missing authoritative NIN fields', async () => {
    const ninFetch = jest.fn().mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ id: 1, status: { state: 'complete', status: 'verified' } }));
    await expect(new QoreIdVerificationAdapter(configuration, ninFetch as unknown as typeof globalThis.fetch)
      .verifyNin('12345678901', claims)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  it('rejects malformed OAuth or provider payloads without returning their contents', async () => {
    const malformedToken = jest.fn().mockResolvedValueOnce(response({ accessToken: 'token', expiresIn: '7200 secs', tokenType: 'Bearer' }));
    await expect(new QoreIdVerificationAdapter(configuration, malformedToken as unknown as typeof globalThis.fetch).verifyNin('12345678901', claims))
      .rejects.toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });

    const malformedResult = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response('{not-json'));
    const pending = new QoreIdVerificationAdapter(configuration, malformedResult as unknown as typeof globalThis.fetch)
      .verifyNin('12345678901', claims);
    await expect(pending).rejects.toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    await expect(pending).rejects.not.toThrow('12345678901');
  });

  it.each([
    0, -1, 0.5, '7200', '7200 secs', Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid provider token lifetime: %j', async (expiresIn) => {
    const fetch = jest.fn().mockResolvedValueOnce(response({ ...token, expiresIn }));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment(fixtureNin)).rejects.toMatchObject({
      status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caches numeric expiresIn=7200 only through HID’s 5400-second safety window', async () => {
    let now = Date.UTC(2026, 0, 1);
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let tokenRequests = 0;
    const fetch = jest.fn(async (url: string, _init?: RequestInit) => url.endsWith('/token')
      ? response({ ...token, accessToken: `fixture-token-${++tokenRequests}` })
      : response(sandboxNinOnlySuccess));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration, fetch as unknown as typeof globalThis.fetch);

    await adapter.verifyNinEnrollment(fixtureNin);
    now += 5_399_000;
    await adapter.verifyNinEnrollment(fixtureNin);
    expect(tokenRequests).toBe(1);
    now += 1_000;
    await adapter.verifyNinEnrollment(fixtureNin);
    expect(tokenRequests).toBe(2);
    const verificationHeaders = fetch.mock.calls.filter(([url]) => !url.endsWith('/token'))
      .map(([, init]) => init?.headers as Record<string, string>);
    expect(verificationHeaders.map((headers) => headers.authorization)).toEqual([
      'Bearer fixture-token-1', 'Bearer fixture-token-1', 'Bearer fixture-token-2',
    ]);
  });

  it('uses a shorter QoreID lifetime when it is below the 5400-second maximum', async () => {
    let now = Date.UTC(2026, 0, 1);
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let tokenRequests = 0;
    const fetch = jest.fn(async (url: string, _init?: RequestInit) => url.endsWith('/token')
      ? response({ ...token, expiresIn: 120, accessToken: `fixture-token-${++tokenRequests}` })
      : response(sandboxNinOnlySuccess));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration, fetch as unknown as typeof globalThis.fetch);

    await adapter.verifyNinEnrollment(fixtureNin);
    now += 119_000;
    await adapter.verifyNinEnrollment(fixtureNin);
    expect(tokenRequests).toBe(1);
    now += 1_000;
    await adapter.verifyNinEnrollment(fixtureNin);
    expect(tokenRequests).toBe(2);
  });

  it('coalesces concurrent cold-cache token refreshes', async () => {
    let resolveToken!: (value: Response) => void;
    const tokenPending = new Promise<Response>((resolve) => { resolveToken = resolve; });
    const fetch = jest.fn((url: string, _init?: RequestInit) => url.endsWith('/token')
      ? tokenPending : Promise.resolve(response(sandboxNinOnlySuccess)));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration, fetch as unknown as typeof globalThis.fetch);
    const first = adapter.verifyNinEnrollment(fixtureNin);
    const second = adapter.verifyNinEnrollment(fixtureNin);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1);

    resolveToken(response(token));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => !url.endsWith('/token'))).toHaveLength(2);
  });

  it('probes OAuth afresh for each connection test even when a usable token is cached', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(response({ ...token, accessToken: 'fixture-token-1' }))
      .mockResolvedValueOnce(response(sandboxNinOnlySuccess))
      .mockResolvedValueOnce(response({ ...token, accessToken: 'fixture-token-2' }))
      .mockResolvedValueOnce(response(sandboxNinOnlySuccess));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await adapter.verifyNinEnrollment(fixtureNin);
    await adapter.testConnection();
    await adapter.verifyNinEnrollment(fixtureNin);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([url]) => !url.endsWith('/token'))).toHaveLength(2);
    expect((fetch.mock.calls[3]?.[1]?.headers as Record<string, string>).authorization)
      .toBe('Bearer fixture-token-2');
  });

  it('invalidates a rejected token and retries the same NIN-only verification exactly once', async () => {
    const payload = sandboxNinOnlySuccess;
    const fetch = jest.fn()
      .mockResolvedValueOnce(response({ ...token, accessToken: 'fixture-token-1' }))
      .mockResolvedValueOnce(response({ providerDiagnostic: 'secret' }, 401))
      .mockResolvedValueOnce(response({ ...token, accessToken: 'fixture-token-2' }))
      .mockResolvedValueOnce(response(payload));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment(fixtureNin)).resolves.toMatchObject({
      state: 'verified', ninEnrollmentBinding: { nin: fixtureNin },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[1]?.[0]).toBe(fetch.mock.calls[3]?.[0]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(fetch.mock.calls[3]?.[1]?.body).toBeUndefined();
    expect((fetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer fixture-token-1');
    expect((fetch.mock.calls[3]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer fixture-token-2');
  });

  it('returns a safe authentication error after a second 401 without further retry', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(response({ ...token, accessToken: 'fixture-token-1' }))
      .mockResolvedValueOnce(response({ providerDiagnostic: 'secret' }, 401))
      .mockResolvedValueOnce(response({ ...token, accessToken: 'fixture-token-2' }))
      .mockResolvedValueOnce(response({ providerDiagnostic: 'secret' }, 401));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    const pending = adapter.verifyNinEnrollment('12345678901');
    await expect(pending).rejects.toMatchObject({ status: 503, code: 'QOREID_AUTHENTICATION_FAILED' });
    await expect(pending).rejects.not.toThrow('secret');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('coalesces refreshes when concurrent verification requests receive 401', async () => {
    let tokenRequests = 0;
    const fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/token')) return response({ ...token, accessToken: `fixture-token-${++tokenRequests}` });
      const authorization = (init?.headers as Record<string, string>)?.authorization;
      return authorization === 'Bearer fixture-token-1' ? response({}, 401) : response(sandboxNinOnlySuccess);
    });
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration, fetch as unknown as typeof globalThis.fetch);
    await adapter.testConnection();
    await expect(Promise.all([adapter.verifyNinEnrollment(fixtureNin), adapter.verifyNinEnrollment(fixtureNin)]))
      .resolves.toHaveLength(2);
    expect(tokenRequests).toBe(2);
    expect(fetch.mock.calls.filter(([url]) => !url.endsWith('/token'))).toHaveLength(4);
  });

  it.each([
    [429, 'QOREID_RATE_LIMITED', 429],
    [503, 'QOREID_PROVIDER_UNAVAILABLE', 503],
    [422, 'QOREID_PROVIDER_REJECTED', 502],
  ])('maps QoreID HTTP %i to a safe HID problem', async (status, code, expectedStatus) => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ providerDiagnostic: 'never-return-this' }, status));
    const pending = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch).verifyNin('12345678901', claims);
    await expect(pending).rejects.toMatchObject({ code, status: expectedStatus });
  });

  it('maps transport failures to a safe availability problem', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('sensitive provider diagnostic'));
    const pending = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch).verifyNin('12345678901', claims);
    await expect(pending).rejects.toBeInstanceOf(DomainProblem);
    await expect(pending).rejects.toMatchObject({ code: 'QOREID_NETWORK_UNAVAILABLE', status: 503 });
  });

  it('aborts a timed-out request without forwarding provider diagnostics', async () => {
    const fetch = jest.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('provider diagnostic', 'AbortError')));
    }));
    const adapter = new QoreIdVerificationAdapter({ ...configuration, timeoutMs: 1 }, fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNin('12345678901', claims)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT', status: 504 });
  });

  it('rejects an oversized provider body before parsing or exposing it', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response('sensitive-photo'.repeat(20_000)));
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);
    const pending = adapter.verifyNin('12345678901', claims);
    await expect(pending).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID', status: 502 });
    await expect(pending).rejects.not.toThrow('sensitive-photo');
  });

  it('keeps the timeout active while the provider body is stalled', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal?.addEventListener('abort', () => controller.error(new Error('sensitive body diagnostic')));
          },
        });
        return Promise.resolve(new Response(body));
      });
    const adapter = new QoreIdVerificationAdapter({ ...configuration, timeoutMs: 20 },
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNin('12345678901', claims)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT', status: 504 });
  });
});
