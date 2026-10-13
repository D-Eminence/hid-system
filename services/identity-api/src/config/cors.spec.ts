import { Controller, Delete, Get, Patch, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { corsOptions } from './cors';

const ALLOWED = 'https://admin.example.test';

let availabilityReads = 0;

/**
 * The two Identity routes that use methods beyond GET and POST, and the public
 * enrollment availability read (FE-4), with the real paths.
 */
@Controller()
class CorsProbeController {
  @Delete('identity/me/access-pin') removePin() { return {}; }
  @Patch('identity/organization-applications/completion/profile') completeProfile() { return {}; }
  @Get('admin/session') session() { return {}; }
  @Get('identity/patient-enrollments/availability') availability() { availabilityReads += 1; return { open: false }; }
}

/** Sends a plain GET, as a browser's fetch does, with an optional Origin. */
function get(port: number, path: string, origin?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'GET',
        headers: origin ? { Origin: origin } : {} }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
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

  // The runtime verifier mounts no CORS middleware, so there a foreign Origin
  // reaches the availability route. Deployed, main.ts's CORS middleware answers
  // it first, as on every route; no Origin and an allowed Origin get the answer.
  describe('the public enrollment availability read (FE-4)', () => {
    const path = '/api/v1/identity/patient-enrollments/availability';

    it('answers a request without an Origin and one from an allowed Origin', async () => {
      availabilityReads = 0;
      const withoutOrigin = await get(port, path);
      expect(withoutOrigin.status).toBe(200);
      expect(JSON.parse(withoutOrigin.body)).toEqual({ open: false });
      expect(withoutOrigin.headers['access-control-allow-origin']).toBeUndefined();
      const allowed = await get(port, path, ALLOWED);
      expect(allowed.status).toBe(200);
      expect(JSON.parse(allowed.body)).toEqual({ open: false });
      expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
      // The answer may be cached (public, max-age=30); the CORS grant is per Origin.
      expect(list(allowed.headers.vary)).toContain('origin');
      expect(availabilityReads).toBe(2);
    });

    it('refuses a foreign Origin before the route, with no CORS permission and no answer', async () => {
      availabilityReads = 0;
      const foreign = await get(port, path, 'https://attacker.example.test');
      expect(foreign.status).toBe(500);
      expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
      expect(foreign.body).not.toContain('"open"');
      expect(availabilityReads).toBe(0);
    });
  });
});
