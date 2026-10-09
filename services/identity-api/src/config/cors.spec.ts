import { Controller, Delete, Get, Patch, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  it('still lists only the methods Identity routes use', async () => {
    const response = await preflight(port, '/api/v1/admin/session', ALLOWED, 'GET');
    expect(list(response.headers['access-control-allow-methods']).sort()).toEqual(['delete', 'get', 'options', 'patch', 'post']);
  });

  it('gives no CORS permission to an origin that is not allowed', async () => {
    const response = await preflight(port, '/api/v1/identity/me/access-pin', 'https://attacker.example.test', 'DELETE');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
  });
});
