import { MetaMapGovChecksClient, METAMAP_NIN_URL, METAMAP_OAUTH_URL, type MetaMapStagingConfig } from './metamap-govchecks.client';
import { randomBytes } from 'node:crypto';

const config: MetaMapStagingConfig = {
  deploymentEnvironment: 'staging', stagingAccessConfirmed: true,
  clientId: 'fixture-client', clientSecret: randomBytes(32).toString('hex'),
  callbackUrl: 'https://api.staging.healthidentitydirectory.com/inactive-test-callback',
};
const input = { documentNumber: '00000000000', firstName: 'Test', lastName: 'Person' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const auth = () => json({ access_token: 'fixture.access.token', expiresIn: 3600 });

describe('MetaMap isolated staging transport', () => {
  it.each([
    { stagingAccessConfirmed: false }, { stagingAccessConfirmed: undefined },
    { deploymentEnvironment: 'production' }, { deploymentEnvironment: 'development' },
    { clientSecret: '' }, { clientId: 'bad:client' },
    { callbackUrl: 'https://api.healthidentitydirectory.com/callback' },
    { callbackUrl: 'https://api.staging.healthidentitydirectory.com/callback?secret=value' },
    { callbackUrl: 'https://user@api.staging.healthidentitydirectory.com/callback' },
  ])('refuses unconfirmed or unsafe configuration without a network call (%j)', async (change) => {
    const request = jest.fn();
    await expect(new MetaMapGovChecksClient({ ...config, ...change }, request).submit(input))
      .rejects.toMatchObject({ code: 'METAMAP_NOT_CONFIGURED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the documented endpoints and OAuth form, and never returns identity assurance', async () => {
    const request = jest.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(json({
      status: 200, id: 'nigerian-nin-validation', error: null,
      data: { nin: input.documentNumber, firstName: input.firstName },
    }));
    const client = new MetaMapGovChecksClient(config, request);
    const result = await client.submit(input);
    expect(request.mock.calls[0][0]).toBe(METAMAP_OAUTH_URL);
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error',
      body: 'grant_type=client_credentials', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}` } });
    expect(request.mock.calls[1][0]).toBe(METAMAP_NIN_URL);
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ ...input,
      callbackUrl: config.callbackUrl, metadata: { requestId: result.requestId } });
    expect(result).toEqual({ state: 'response-received', requestId: expect.any(String) });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(result)).not.toContain(input.documentNumber);
    expect(JSON.stringify(client)).not.toContain(config.clientSecret);
  });

  it('does not mistake a 200 check error for a verified result', async () => {
    const request = jest.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(json({
      status: 200, error: { code: 'nigerianNin.notFound' },
    }));
    expect(await new MetaMapGovChecksClient(config, request).submit(input))
      .toEqual({ state: 'response-received', requestId: expect.any(String) });
  });

  it('shares one in-flight token request and expires its memory cache early', async () => {
    let now = 0;
    const request = jest.fn(async (url: RequestInfo | URL) => url === METAMAP_OAUTH_URL ? auth() : json({}));
    const client = new MetaMapGovChecksClient(config, request, () => now);
    await Promise.all([client.submit(input), client.submit(input)]);
    expect(request.mock.calls.filter(([url]) => url === METAMAP_OAUTH_URL)).toHaveLength(1);
    now = 3300_000;
    await client.submit(input);
    expect(request.mock.calls.filter(([url]) => url === METAMAP_OAUTH_URL)).toHaveLength(2);
  });

  it.each([400, 401, 429, 500, 302])('does not replay a NIN submission after HTTP %s', async (status) => {
    const request = jest.fn().mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(json({ error: config.clientSecret, nin: input.documentNumber }, status));
    const error = await new MetaMapGovChecksClient(config, request).submit(input).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'METAMAP_SUBMISSION_UNCONFIRMED' });
    expect(String(error)).not.toContain(config.clientSecret);
    expect(String(error)).not.toContain(input.documentNumber);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { access_token: 'token' }, { access_token: 'token', expiresIn: 0 },
    { access_token: 'bad\r\ntoken', expiresIn: 3600 },
    { access_token: 'x'.repeat(40_000), expiresIn: 3600 },
  ])('rejects malformed or oversized authentication before a NIN request', async (value) => {
    const request = jest.fn().mockResolvedValueOnce(json(value));
    await expect(new MetaMapGovChecksClient(config, request).submit(input))
      .rejects.toMatchObject({ code: 'METAMAP_AUTH_UNAVAILABLE' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled request and does not expose network errors', async () => {
    jest.useFakeTimers();
    try {
      const request = jest.fn().mockImplementation(() => new Promise(() => undefined));
      const pending = new MetaMapGovChecksClient({ ...config, timeoutMs: 250 }, request).submit(input);
      const assertion = expect(pending).rejects.toMatchObject({ code: 'METAMAP_AUTH_UNAVAILABLE' });
      await jest.advanceTimersByTimeAsync(251);
      await assertion;
      expect(request.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });

  it('rejects malformed NIN input before transmitting anything', async () => {
    const request = jest.fn();
    await expect(new MetaMapGovChecksClient(config, request).submit({ ...input, documentNumber: 'invalid' }))
      .rejects.toMatchObject({ code: 'METAMAP_INPUT_INVALID' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['invalid-json', JSON.stringify({ data: 'x'.repeat(262_144) })])
    ('fails closed on malformed or oversized NIN responses', async (body) => {
      const request = jest.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response(body, {
        headers: { 'content-type': 'application/json' },
      }));
      await expect(new MetaMapGovChecksClient(config, request).submit(input))
        .rejects.toMatchObject({ code: 'METAMAP_SUBMISSION_UNCONFIRMED' });
      expect(request).toHaveBeenCalledTimes(2);
    });
});
