import { DomainProblem } from '../common/problem';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';

const configuration = {
  baseUrl: 'https://api.qoreid.com',
  clientId: 'server-only-client-id',
  clientSecret: 'server-only-client-secret',
  timeoutMs: 500,
};

const token = { accessToken: 'server-only-access-token', expiresIn: '7200 secs', tokenType: 'Bearer' };
const claims = { firstName: 'Bunch', lastName: 'Dillon', dateOfBirth: '1974-01-06' };
const complete = {
  id: 48291,
  status: { state: 'complete', status: 'verified' },
  summary: { nin_check: { status: 'EXACT_MATCH', fieldMatches: { firstname: true, lastname: true } } },
  nin: { nin: '12345678901', firstname: 'Bunch', lastname: 'Dillon', birthdate: '06-01-1974',
    photo: 'sensitive-photo', address: 'sensitive-address' },
};
const completeCac = {
  id: 71, status: { state: 'complete', status: 'verified' }, summary: { cac_check: 'verified' },
  cac: { rcNumber: '1234', companyName: 'Example Clinic', companyType: 'Private Limited',
    registrationDate: '07-Jul-95', status: 'Active', headOfficeAddress: '123 Example Street, Lagos' },
};
const holderProof = () => ({
  status: 'verified', method: 'provider_possession', nin: '12345678901',
  transactionReference: '48291', verifiedAt: new Date().toISOString(),
});
const enrollmentConfiguration = {
  ...configuration,
  ninOnlyEnrollmentEnabled: true,
  // Synthetic fixture seam only. Production must map the approved provider contract.
  holderAssertionExtractor: (payload: unknown) => (payload as { holderProof?: unknown }).holderProof,
};

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('QoreID verification adapter', () => {
  it('uses QoreID OAuth fields and submits canonical name and DOB claims for NIN', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response(complete));
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);

    await expect(adapter.verifyNin('12345678901', claims)).resolves.toEqual({
      provider: 'qoreid', state: 'verified', providerReference: '48291', respondedAt: expect.any(String),
      ninBinding: { firstName: 'Bunch', lastName: 'Dillon', dateOfBirth: '1974-01-06' },
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
      firstname: 'Bunch', lastname: 'Dillon', dob: '1974-01-06',
    }));
    const ninHeaders = fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(ninHeaders).toEqual({ accept: 'application/json', authorization: 'Bearer server-only-access-token',
      'content-type': 'application/json' });
  });

  it('uses CAC Basic V2 with only regNumber in the JSON body', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response(completeCac));
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);

    await expect(adapter.verifyCac('RC1234')).resolves.toMatchObject({ state: 'verified', providerReference: '71',
      cacBinding: { registrationNumber: '1234', companyName: 'Example Clinic', entityType: 'Private Limited',
        registrationDate: '1995-07-07', address: '123 Example Street, Lagos', registryStatus: 'Active' } });
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.qoreid.com/v2/ng/identities/cac-basic');
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ regNumber: 'RC1234' }));
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({ regNumber: 'RC1234' });
  });

  it('keeps the unconfirmed NIN-only contract disabled before any provider request', async () => {
    const fetch = jest.fn();
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment('12345678901')).rejects.toMatchObject({
      status: 503, code: 'QOREID_NIN_ONLY_CONTRACT_UNCONFIRMED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a reviewed holder-proof mapper before any NIN-only provider request', async () => {
    const fetch = jest.fn();
    const adapter = new QoreIdVerificationAdapter({ ...configuration, ninOnlyEnrollmentEnabled: true },
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment('12345678901')).rejects.toMatchObject({
      status: 503, code: 'QOREID_HOLDER_ASSERTION_CONTRACT_UNCONFIRMED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends only NIN with an explicitly enabled contract and retains bounded registry identity', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response({
      ...complete, holderProof: holderProof(), nin: { ...complete.nin, gender: 'F', phone: '08000000000',
        photo: 'ZmFrZQ==', address: '123 Example Street, Lagos' },
    }));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment('12345678901')).resolves.toMatchObject({
      state: 'verified', providerReference: '48291', ninEnrollmentBinding: {
        nin: '12345678901', firstName: 'Bunch', lastName: 'Dillon', dateOfBirth: '1974-01-06',
        gender: 'female', phoneNumber: '08000000000', photo: 'ZmFrZQ==',
        address: '123 Example Street, Lagos',
      },
    });
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.qoreid.com/v1/ng/identities/nin/12345678901');
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it('rejects a NIN-only response missing the transaction reference or authoritative fields', async () => {
    const full = { ...complete, nin: { ...complete.nin, gender: 'F', phone: '08000000000',
      photo: 'ZmFrZQ==', address: '123 Example Street, Lagos' } };
    for (const payload of [
      { ...full, id: undefined },
      { ...full, nin: { ...full.nin, nin: '99999999999' } },
      { ...full, nin: { ...full.nin, gender: undefined } },
      { ...full, nin: { ...full.nin, phone: undefined } },
      { ...full, nin: { ...full.nin, photo: undefined } },
      { ...full, nin: { ...full.nin, address: undefined } },
    ]) {
      const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response({
        ...payload, holderProof: holderProof(),
      }));
      const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
        fetch as unknown as typeof globalThis.fetch);
      await expect(adapter.verifyNinEnrollment('12345678901')).rejects.toMatchObject({
        code: 'QOREID_PROVIDER_RESPONSE_INVALID',
      });
    }
  });

  it.each([
    undefined,
    { ...holderProof(), status: 'pending' },
    { ...holderProof(), method: 'registry_lookup' },
    { ...holderProof(), nin: '99999999999' },
    { ...holderProof(), transactionReference: '99999' },
    { ...holderProof(), verifiedAt: new Date(Date.now() - 11 * 60_000).toISOString() },
    { ...holderProof(), verifiedAt: new Date(Date.now() + 2 * 60_000).toISOString() },
  ])('rejects NIN-only demographic lookup without fresh provider holder proof', async (proof) => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response({
      ...complete, holderProof: proof,
      nin: { ...complete.nin, gender: 'F' },
    }));
    const adapter = new QoreIdVerificationAdapter(enrollmentConfiguration,
      fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNinEnrollment('12345678901')).rejects.toMatchObject({
      code: 'QOREID_PROVIDER_RESPONSE_INVALID',
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

  it('rejects a verified provider status with missing authoritative NIN or CAC fields', async () => {
    const ninFetch = jest.fn().mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ id: 1, status: { state: 'complete', status: 'verified' } }));
    await expect(new QoreIdVerificationAdapter(configuration, ninFetch as unknown as typeof globalThis.fetch)
      .verifyNin('12345678901', claims)).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    const cacFetch = jest.fn().mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ ...completeCac, cac: { companyName: 'Example Clinic' } }));
    await expect(new QoreIdVerificationAdapter(configuration, cacFetch as unknown as typeof globalThis.fetch)
      .verifyCac('RC1234')).rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
  });

  it('rejects malformed OAuth or provider payloads without returning their contents', async () => {
    const malformedToken = jest.fn().mockResolvedValueOnce(response({ accessToken: 'token', expiresIn: 7200, tokenType: 'Bearer' }));
    await expect(new QoreIdVerificationAdapter(configuration, malformedToken as unknown as typeof globalThis.fetch).verifyNin('12345678901', claims))
      .rejects.toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });

    const malformedResult = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response('{not-json'));
    const pending = new QoreIdVerificationAdapter(configuration, malformedResult as unknown as typeof globalThis.fetch)
      .verifyNin('12345678901', claims);
    await expect(pending).rejects.toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    await expect(pending).rejects.not.toThrow('12345678901');
  });

  it.each([
    [401, 'QOREID_AUTHENTICATION_FAILED', 503],
    [429, 'QOREID_PROVIDER_REJECTED', 502],
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
