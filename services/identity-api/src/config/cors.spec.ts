import { Controller, Delete, Get, Patch, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProblemDetailsFilter } from '../common/problem';
import { corsOptions } from './cors';

const ALLOWED = 'https://admin.example.test';

/** The two Identity routes that use methods beyond GET and POST, with the real paths. */
@Controller()
class CorsProbeController {
  @Delete('identity/me/access-pin') removePin() { return {}; }
  @Patch('identity/organization-applications/completion/profile') completeProfile() { return {}; }
  @Get('admin/session') session() { return {}; }
}

/** Sends a browser-style CORS preflight and returns its status and headers. */
function preflight(port: number, path: string, origin: string, method: string, headers = 'content-type') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers } },
    (response) => { response.resume(); response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers })); });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

const list = (value: string | string[] | undefined) => String(value ?? '').toLowerCase().split(',').map((item) => item.trim());

describe('Identity CORS preflight (Stage 5)', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [CorsProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.enableCors(corsOptions(`${ALLOWED}, https://other.example.test`));
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(() => app.close());

  it.each([
    ['DELETE', '/api/v1/identity/me/access-pin'],
    ['PATCH', '/api/v1/identity/organization-applications/completion/profile'],
  ])('allows a %s preflight from an allowed origin with credentials and the CSRF header', async (method, path) => {
    const response = await preflight(port, path, ALLOWED, method, 'content-type,x-csrf-token,if-match,idempotency-key');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(list(response.headers['access-control-allow-methods'])).toContain(method.toLowerCase());
    expect(list(response.headers['access-control-allow-headers'])).toEqual(
      expect.arrayContaining(['content-type', 'x-csrf-token', 'if-match', 'idempotency-key']));
  });

  it('allows X-HID-Client on a cookie refresh preflight, so the staff and patient apps can name themselves', async () => {
    const response = await preflight(port, '/api/v1/auth/refresh', ALLOWED, 'POST', 'x-csrf-token,x-hid-client');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(list(response.headers['access-control-allow-headers'])).toEqual(
      expect.arrayContaining(['x-csrf-token', 'x-hid-client']));
  });

  it('allows X-HID-Client on a cookie sign-out preflight, so each app ends only its own kind of sign-in', async () => {
    const response = await preflight(port, '/api/v1/auth/logout', ALLOWED, 'POST', 'x-csrf-token,x-hid-client');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(list(response.headers['access-control-allow-headers'])).toEqual(
      expect.arrayContaining(['x-csrf-token', 'x-hid-client']));
  });

  it('still lists only the methods Identity routes use', async () => {
    const response = await preflight(port, '/api/v1/admin/session', ALLOWED, 'GET');
    expect(list(response.headers['access-control-allow-methods']).sort()).toEqual(['delete', 'get', 'options', 'patch', 'post']);
  });

  it('lists exactly the request headers Identity accepts from a browser', async () => {
    const response = await preflight(port, '/api/v1/admin/session', ALLOWED, 'GET');
    expect(list(response.headers['access-control-allow-headers']).sort()).toEqual(['authorization', 'content-type',
      'idempotency-key', 'if-match', 'x-correlation-id', 'x-csrf-token', 'x-facility-id', 'x-hid-client', 'x-hid-internal-caller',
      'x-hid-scanner-authorization', 'x-hid-service-authorization', 'x-hid-service-token', 'x-purpose-of-use']);
  });

  it('gives no CORS permission to an origin that is not allowed', async () => {
    const response = await preflight(port, '/api/v1/identity/me/access-pin', 'https://attacker.example.test', 'DELETE');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
  });
});

/** Sends a plain browser request (no preflight) with the given Origin and returns its status, headers and body. */
function plain(port: number, path: string, origin: string | undefined, method: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const withBody = method !== 'GET' && method !== 'OPTIONS';
    // A fresh connection each time: a refused request's unread body ends the connection it came on.
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method, agent: false,
      headers: { ...(origin ? { Origin: origin } : {}), ...(withBody ? { 'content-type': 'application/json' } : {}),
        ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'DELETE' } : {}) } },
    (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    outgoing.on('error', reject);
    outgoing.end(withBody ? '{}' : undefined);
  });
}

// A19: the origin callback refused a disallowed Origin with a plain Error,
// which the problem filter answers 500 INTERNAL_ERROR: a forged Origin raised
// the 5xx alarms and a missing portal origin looked like a server fault.
describe('Identity CORS refusal of a disallowed origin (A19)', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [CorsProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.enableCors(corsOptions(ALLOWED));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(() => app.close());

  it.each(['GET', 'DELETE', 'OPTIONS'])('answers a %s from a disallowed origin 403 ORIGIN_DENIED, not 500, with no CORS headers',
    async (method) => {
      const response = await plain(port, method === 'GET' ? '/api/v1/admin/session' : '/api/v1/identity/me/access-pin',
        'https://attacker.example.test', method);
      expect(response.status).toBe(403);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(JSON.parse(response.body)).toMatchObject({ status: 403, code: 'ORIGIN_DENIED' });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

  it('keeps a request without Origin (a same-origin GET) and an allowed origin working', async () => {
    expect((await plain(port, '/api/v1/admin/session', undefined, 'GET')).status).toBe(200);
    const allowed = await plain(port, '/api/v1/admin/session', ALLOWED, 'GET');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
  });
});
