import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { corsOptions } from './cors';

// The CORS answer main.ts gives, through Nest's own CORS handling. The patient
// site (app.healthidentitydirectory.com) calls the API on another origin, so
// every custom header it sends needs a preflight that names it: the card-link
// routes (0118) send X-Card-View on GET view, POST end-view and GET records.
const site = 'https://app.healthidentitydirectory.com';

@Controller('card-share')
class ProbeController {
  @Get('view')
  view(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('CORS (main.ts)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.enableCors(corsOptions(new Set([site])));
    await app.init();
  });
  afterAll(() => app.close());

  it('allows X-Card-View in a preflight from the patient site, with credentials', async () => {
    const answer = await request(app.getHttpServer()).options('/api/v1/card-share/view')
      .set('Origin', site).set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-card-view');
    expect(answer.status).toBe(204);
    expect(answer.headers['access-control-allow-origin']).toBe(site);
    expect(answer.headers['access-control-allow-credentials']).toBe('true');
    expect(String(answer.headers['access-control-allow-headers']).split(',')).toContain('x-card-view');
  });

  it('still refuses another origin', async () => {
    const answer = await request(app.getHttpServer()).options('/api/v1/card-share/view')
      .set('Origin', 'https://attacker.example').set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-card-view');
    expect(answer.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is what main.ts gives Nest', () => {
    expect(readFileSync(join(__dirname, '..', 'main.ts'), 'utf8')).toMatch(/app\.enableCors\(corsOptions\(allowedOrigins\)\)/);
  });
});
