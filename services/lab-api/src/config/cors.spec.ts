import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProblemDetailsFilter } from '../common/problem';
import { corsOptions } from './cors';

// A19: the origin callback refused a disallowed Origin with a plain Error,
// which the problem filter answers 500 INTERNAL_ERROR: a forged Origin raised
// the 5xx alarms and a missing portal origin looked like a server fault. The
// settings moved from main.ts to config/cors.ts unchanged, so they are tested
// here as main.ts applies them.

const ALLOWED = 'https://app.example.test';
const DENIED = 'https://attacker.example.test';

@Controller('lab/requests')
class CorsProbeController {
  @Get() list() { return []; }
  @Post() create() { return {}; }
}

function send(port: number, method: string, origin: string | undefined, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/lab/requests', method,
      headers: { ...(origin ? { Origin: origin } : {}), ...headers } },
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

const list = (value: string | string[] | undefined) => String(value ?? '').toLowerCase().split(',').map((item) => item.trim())
  .filter(Boolean).sort();

describe('Lab CORS (A19)', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [CorsProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.enableCors(corsOptions(`${ALLOWED}, https://other.example.test`));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(() => app.close());

  it.each(['GET', 'POST', 'OPTIONS'])('answers a %s from a disallowed origin 403 ORIGIN_DENIED, not 500, with no CORS headers',
    async (method) => {
      const response = await send(port, method, DENIED, method === 'OPTIONS'
        ? { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' } : {});
      expect(response.status).toBe(403);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(JSON.parse(response.body)).toMatchObject({ status: 403, code: 'ORIGIN_DENIED' });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

  it('keeps a request without Origin (a same-origin GET) working', async () => {
    expect((await send(port, 'GET', undefined)).status).toBe(200);
  });

  it('keeps the preflight of an allowed origin: credentials, methods and headers as before', async () => {
    const response = await send(port, 'OPTIONS', ALLOWED, { 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-csrf-token' });
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-max-age']).toBe('600');
    expect(list(response.headers['access-control-allow-methods'])).toEqual(['get', 'options', 'patch', 'post']);
    expect(list(response.headers['access-control-allow-headers'])).toEqual(['authorization', 'content-type', 'idempotency-key', 'if-match', 'x-correlation-id', 'x-csrf-token', 'x-facility-id', 'x-purpose-of-use']);
  });

  it('exposes the same response headers to an allowed origin as before', async () => {
    const response = await send(port, 'GET', ALLOWED);
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(list(response.headers['access-control-expose-headers'])).toEqual(['etag', 'location', 'x-correlation-id', 'x-csrf-token']);
  });
});
