import { DomainProblem } from '../common/problem';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';

const configuration = {
  baseUrl: 'https://api.qoreid.com',
  clientId: 'server-only-client-id',
  clientSecret: 'server-only-client-secret',
  timeoutMs: 500,
};

const token = { accessToken: 'server-only-access-token', expiresIn: '7200 secs', tokenType: 'Bearer' };
const complete = { id: 48291, status: { state: 'complete', status: 'verified' } };

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('QoreID verification adapter', () => {
  it('uses QoreID OAuth JSON field names and a path-only NIN request', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response(complete));
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);

    await expect(adapter.verifyNin('12345678901')).resolves.toEqual({
      provider: 'qoreid', state: 'verified', providerReference: '48291', respondedAt: expect.any(String),
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
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
    const ninHeaders = fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(ninHeaders).toEqual({ accept: 'application/json', authorization: 'Bearer server-only-access-token' });
    expect(JSON.stringify(fetch.mock.calls[1])).not.toContain('firstName');
    expect(JSON.stringify(fetch.mock.calls[1])).not.toContain('dateOfBirth');
  });

  it('uses CAC Basic V2 with only regNumber in the JSON body', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ id: 71, status: { state: 'complete', status: 'not_verified' } }));
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);

    await expect(adapter.verifyCac('RC1234')).resolves.toMatchObject({ state: 'not_verified', providerReference: '71' });
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.qoreid.com/v2/ng/identities/cac-basic');
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ regNumber: 'RC1234' }));
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({ regNumber: 'RC1234' });
  });

  it.each([
    [{ id: 1, status: { state: 'pending', status: 'queued' } }, 'incomplete'],
    [{ id: 1, status: { state: 'complete', status: 'declined' } }, 'not_verified'],
  ] as const)('never treats a non-verified provider state as verified', async (payload, state) => {
    const fetch = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response(payload));
    const adapter = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNin('12345678901')).resolves.toMatchObject({ state });
  });

  it('rejects malformed OAuth or provider payloads without returning their contents', async () => {
    const malformedToken = jest.fn().mockResolvedValueOnce(response({ accessToken: 'token', expiresIn: 7200, tokenType: 'Bearer' }));
    await expect(new QoreIdVerificationAdapter(configuration, malformedToken as unknown as typeof globalThis.fetch).verifyNin('12345678901'))
      .rejects.toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });

    const malformedResult = jest.fn().mockResolvedValueOnce(response(token)).mockResolvedValueOnce(response('{not-json'));
    const pending = new QoreIdVerificationAdapter(configuration, malformedResult as unknown as typeof globalThis.fetch)
      .verifyNin('12345678901');
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
    const pending = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch).verifyNin('12345678901');
    await expect(pending).rejects.toMatchObject({ code, status: expectedStatus });
  });

  it('maps transport failures to a safe availability problem', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('sensitive provider diagnostic'));
    const pending = new QoreIdVerificationAdapter(configuration, fetch as unknown as typeof globalThis.fetch).verifyNin('12345678901');
    await expect(pending).rejects.toBeInstanceOf(DomainProblem);
    await expect(pending).rejects.toMatchObject({ code: 'QOREID_NETWORK_UNAVAILABLE', status: 503 });
  });

  it('aborts a timed-out request without forwarding provider diagnostics', async () => {
    const fetch = jest.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('provider diagnostic', 'AbortError')));
    }));
    const adapter = new QoreIdVerificationAdapter({ ...configuration, timeoutMs: 1 }, fetch as unknown as typeof globalThis.fetch);
    await expect(adapter.verifyNin('12345678901')).rejects.toMatchObject({ code: 'QOREID_TIMEOUT', status: 504 });
  });
});
