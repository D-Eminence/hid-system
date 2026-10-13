import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProblemDetailsFilter } from '../common/problem';
import { corsOptions } from './cors';

const ALLOWED = 'https://pharmacy.example.test';

@Controller('pharmacy')
class CorsProbeController {
  @Get('prescriptions') list() { return []; }
  @Post('dispensations') dispense() { return {}; }
}

/** Sends a browser-style CORS preflight and returns its status and headers. */
function preflight(port: number, path: string, origin: string, method: string, headers: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers } },
    (response) => { response.resume(); response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers })); });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

const list = (value: string | string[] | undefined) => String(value ?? '').toLowerCase().split(',').map((item) => item.trim());

describe('Pharmacy CORS preflight (Stage 5)', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [CorsProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.enableCors(corsOptions(ALLOWED));
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(() => app.close());

  it('allows the CSRF header that cookie sessions send, from an allowed origin', async () => {
    const response = await preflight(port, '/api/v1/pharmacy/dispensations', ALLOWED, 'POST',
      'content-type,x-csrf-token,idempotency-key,x-facility-id');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(list(response.headers['access-control-allow-headers'])).toEqual(
      expect.arrayContaining(['x-csrf-token', 'content-type', 'idempotency-key', 'x-facility-id']));
  });

  it('keeps the methods to GET and POST, the only ones pharmacy routes use', async () => {
    const response = await preflight(port, '/api/v1/pharmacy/prescriptions', ALLOWED, 'GET', 'content-type');
    expect(list(response.headers['access-control-allow-methods']).sort()).toEqual(['get', 'options', 'post']);
  });

  it('lists exactly the request headers the pharmacy console sends', async () => {
    const response = await preflight(port, '/api/v1/pharmacy/prescriptions', ALLOWED, 'GET', 'content-type');
    expect(list(response.headers['access-control-allow-headers']).sort()).toEqual(['authorization', 'content-type',
      'idempotency-key', 'x-correlation-id', 'x-csrf-token', 'x-facility-id', 'x-purpose-of-use']);
  });

  it('gives no CORS permission to an origin that is not allowed', async () => {
    const response = await preflight(port, '/api/v1/pharmacy/dispensations', 'https://attacker.example.test', 'POST',
      'x-csrf-token');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-headers']).toBeUndefined();
  });
});

/** A plain browser request (no preflight) with the given Origin: its status, headers and body. */
function plain(port: number, path: string, origin: string | undefined, method: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method, headers: origin ? { Origin: origin } : {} },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

// A19: the origin callback refused a disallowed Origin with a plain Error,
// which the problem filter answers 500.
describe('Pharmacy CORS refusal of a disallowed origin (A19)', () => {
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

  it.each([['GET', '/api/v1/pharmacy/prescriptions'], ['POST', '/api/v1/pharmacy/dispensations']])(
    'answers a %s from a disallowed origin 403 ORIGIN_DENIED, not 500, with no CORS headers', async (method, path) => {
      const response = await plain(port, path, 'https://attacker.example.test', method);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ status: 403, code: 'ORIGIN_DENIED' });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

  it('keeps a request without Origin working', async () => {
    expect((await plain(port, '/api/v1/pharmacy/prescriptions', undefined, 'GET')).status).toBe(200);
  });
});
