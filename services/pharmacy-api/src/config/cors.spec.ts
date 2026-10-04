import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { pharmacyCorsOptions } from './cors';

@Controller('probe')
class ProbeController {
  @Get()
  read() { return { ok: true }; }
}

describe('Pharmacy browser preflight', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = module.createNestApplication();
    app.enableCors(pharmacyCorsOptions(new Set(['https://portal.example.test'])));
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => { await app.close(); });

  it('accepts the CSRF header for a credentialed dispensing command', async () => {
    const response = await fetch(`${await app.getUrl()}/probe`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://portal.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-csrf-token',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://portal.example.test');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')).toContain('x-csrf-token');
  });
});
