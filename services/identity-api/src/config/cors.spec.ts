import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { identityCorsOptions } from './cors';

@Controller('probe')
class ProbeController {
  @Get()
  read() { return { ok: true }; }
}

describe('Identity browser preflight', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = module.createNestApplication();
    app.enableCors(identityCorsOptions(new Set(['https://portal.example.test'])));
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it.each(['PATCH', 'DELETE'])('allows supported %s patient mutations with CSRF evidence', async (method) => {
    const response = await request(app.getHttpServer())
      .options('/probe')
      .set('Origin', 'https://portal.example.test')
      .set('Access-Control-Request-Method', method)
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://portal.example.test');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toContain(method);
    expect(response.headers['access-control-allow-headers']).toContain('x-csrf-token');
  });
});
