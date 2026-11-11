import {
  BadRequestException,
  Catch,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  type ArgumentsHost,
  type ExceptionFilter,
  type NestInterceptor,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import { lastValueFrom, of, throwError } from 'rxjs';
import request from 'supertest';
import * as reporting from '../src/reporting';
import { ErrorReportingInterceptor, isClientError, routeTemplateOf, type ExecutionContextLike } from '../src';

// Compile-time check: assignable to Nest's own interceptor contract.
const asNest: NestInterceptor = new ErrorReportingInterceptor();
void asNest;

function httpContext(req: unknown): ExecutionContextLike {
  return { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) };
}

const req = { baseUrl: '', route: { path: '/api/v1/patients/:pid' }, url: '/api/v1/patients/8f14e45f?nin=12345678901' };

describe('ErrorReportingInterceptor (unit)', () => {
  let capture: jest.SpyInstance;
  beforeEach(() => {
    capture = jest.spyOn(reporting, 'captureServerError').mockImplementation(() => undefined);
  });
  afterEach(() => capture.mockRestore());

  const run = (error: unknown) =>
    lastValueFrom(new ErrorReportingInterceptor().intercept(httpContext(req), { handle: () => throwError(() => error) }));

  it('reports a plain Error with the route template and rethrows the same error', async () => {
    const error = new Error('Adaeze Okonkwo');
    await expect(run(error)).rejects.toBe(error);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(error, '/api/v1/patients/:pid');
  });

  it('reports 5xx HttpExceptions', async () => {
    const error = new InternalServerErrorException();
    await expect(run(error)).rejects.toBe(error);
    expect(capture).toHaveBeenCalledWith(error, '/api/v1/patients/:pid');
  });

  it.each([new BadRequestException(), new NotFoundException(), new HttpException('x', HttpStatus.CONFLICT)])(
    'does not report client error %p but rethrows it',
    async (error) => {
      await expect(run(error)).rejects.toBe(error);
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it('passes values through untouched and reports nothing', async () => {
    const value = { ok: true };
    await expect(
      lastValueFrom(new ErrorReportingInterceptor().intercept(httpContext(req), { handle: () => of(value) })),
    ).resolves.toBe(value);
    expect(capture).not.toHaveBeenCalled();
  });

  it('prefixes the router base URL and ignores non-string or non-http routes', () => {
    expect(routeTemplateOf(httpContext({ baseUrl: '/api/v1', route: { path: '/labs/:id' } }))).toBe('/api/v1/labs/:id');
    expect(routeTemplateOf(httpContext({ route: { path: /regex/ } }))).toBeUndefined();
    expect(routeTemplateOf(httpContext({}))).toBeUndefined();
    expect(routeTemplateOf({ getType: () => 'rpc', switchToHttp: () => ({ getRequest: () => req }) })).toBeUndefined();
  });

  it('treats only HttpException-like statuses below 500 as client errors', () => {
    expect(isClientError(new NotFoundException())).toBe(true);
    expect(isClientError(new InternalServerErrorException())).toBe(false);
    expect(isClientError(new Error('x'))).toBe(false);
    expect(isClientError({ getStatus: () => { throw new Error('bad'); } })).toBe(false);
    expect(isClientError('string')).toBe(false);
  });
});

@Controller('patients')
class PatientsController {
  @Get(':pid')
  find(@Param('pid') _pid: string): never {
    throw new Error('Patient Adaeze Okonkwo NIN 12345678901');
  }

  @Get(':pid/missing')
  missing(): never {
    throw new NotFoundException('Patient not found');
  }

  @Post(':pid/notes')
  create(): { ok: boolean } {
    return { ok: true };
  }
}

/** Stand-in for a service's own filter (e.g. ProblemDetailsFilter). */
@Catch()
class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    host.switchToHttp().getResponse<Response>().status(status).json({ status, filtered: true });
  }
}

describe('ErrorReportingInterceptor (Nest application)', () => {
  let app: INestApplication;
  let capture: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [PatientsController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ProblemFilter());
    app.useGlobalInterceptors(new ErrorReportingInterceptor());
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    capture = jest.spyOn(reporting, 'captureServerError').mockImplementation(() => undefined);
  });
  afterEach(() => capture.mockRestore());

  it('reports the Express route template, never the concrete URL, and keeps the filter response', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/patients/8f14e45f?nin=12345678901');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: 500, filtered: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![1]).toBe('/api/v1/patients/:pid');
  });

  it('does not report 404s and keeps the filter response', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/patients/8f14e45f/missing');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ status: 404, filtered: true });
    expect(capture).not.toHaveBeenCalled();
  });

  it('leaves successful responses unchanged', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/patients/1/notes');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
    expect(capture).not.toHaveBeenCalled();
  });
});
