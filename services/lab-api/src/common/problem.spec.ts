import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { HidRequest } from './request-context';
import { DomainProblem, ProblemDetailsFilter } from './problem';

describe('ProblemDetailsFilter PHI safety', () => {
  it('does not log or echo a raw exception, stack, concrete patient path, or query string', () => {
    const patientId = '50000000-0000-4000-8000-000000000001';
    const secret = 'sensitive-upstream-sql-value';
    const request = {
      correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ',
      method: 'GET',
      path: `/api/v1/ehr/patients/${patientId}/encounters`,
      originalUrl: `/api/v1/ehr/patients/${patientId}/encounters?search=${secret}`,
      route: { path: '/ehr/patients/:patientId/encounters' },
    } as unknown as HidRequest;
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    new ProblemDetailsFilter().catch(new Error(`${secret} at ${request.path}\nstack:${patientId}`), host);

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(patientId);
    expect(logged).not.toContain(request.path);
    expect(logged).toContain('/ehr/patients/:patientId/encounters');
    const problem = (response.json as jest.Mock).mock.calls[0]?.[0] as { instance: string; detail: string };
    expect(problem.instance).toBe(`urn:hid:request:${request.correlationId}`);
    expect(JSON.stringify(problem)).not.toContain(secret);
    expect(JSON.stringify(problem)).not.toContain(patientId);
  });

  it('normalizes an oversized JSON body to RFC7807 413 without echoing parser content', () => {
    const request = {
      correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ',
      method: 'POST',
      route: { path: '/ehr/patients/:patientId/encounters/:encounterId/clinical-notes' },
    } as unknown as HidRequest;
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const parserError = Object.assign(new Error('raw oversized clinical note content'), {
      type: 'entity.too.large',
      status: 413,
    });

    new ProblemDetailsFilter().catch(parserError, host);

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.type).toHaveBeenCalledWith('application/problem+json');
    const problem = (response.json as jest.Mock).mock.calls[0]?.[0] as { status: number; code: string; detail: string };
    expect(problem).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(JSON.stringify(problem)).not.toContain('raw oversized clinical note content');
  });
});

// Lab maps no SQLSTATE in its problem filter: only EHR-order acceptance maps its
// own database refusals, in lab-work-items.service.ts. Every other command
// answers a database error 500, as before fix/ehr-lab-handoff-resend. OCR
// stores a Lab 500 from POST /lab/imports/from-ocr as the retryable
// OWNING_SERVICE_UNAVAILABLE, and a Lab 4xx as a terminal refusal of the
// reviewed publication.
describe('ProblemDetailsFilter database errors', () => {
  const secret = 'sensitive-row-value-for-patient-50000000';
  const respond = (exception: unknown, route: string) => {
    const request = {
      correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ',
      method: 'POST',
      route: { path: route },
    } as unknown as HidRequest;
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ArgumentsHost;
    new ProblemDetailsFilter().catch(exception, host);
    expect(response.status).toHaveBeenCalledTimes(1);
    return (response.json as jest.Mock).mock.calls[0]?.[0] as { status: number; code: string; detail: string };
  };
  const databaseError = (code: string) => Object.assign(new Error(`${secret} violates a guard`), { code });
  const routes = ['/lab/imports/from-ocr', '/lab/imports', '/lab/results/:resultId/verify', '/lab/work-items/accept-ehr-order'];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['23514', '23505', '23503', '42501', '22001', '22003', '22007', '22008', '22P02', '23502', 'XX000', 'P0001'])(
    'answers SQLSTATE %s that reaches it unmapped with 500 INTERNAL_ERROR and the fixed detail, on every route',
    (sqlState) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      for (const route of routes) {
        const problem = respond(databaseError(sqlState), route);
        expect(problem).toMatchObject({ status: 500, code: 'INTERNAL_ERROR',
          detail: 'The service could not complete the request.' });
        expect(JSON.stringify(problem)).not.toContain(secret);
        expect(JSON.stringify(problem)).not.toContain(sqlState);
      }
      expect(warn).not.toHaveBeenCalled();
    });

  it('answers a domain problem that stands for a database refusal as the problem, and logs only its SQLSTATE and route', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const detail = 'Lab accepts only the current version of an active EHR order, exactly as the EHR holds it';
    const problem = respond(new DomainProblem(409, 'LAB_ORDER_NOT_CURRENT', detail, undefined, { cause: databaseError('23514') }),
      '/lab/work-items/accept-ehr-order');
    expect(problem).toMatchObject({ status: 409, code: 'LAB_ORDER_NOT_CURRENT', detail });
    expect(JSON.stringify(problem)).not.toContain(secret);
    expect(JSON.stringify(problem)).not.toContain('23514');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('23514');
    expect(logged).toContain('LAB_ORDER_NOT_CURRENT');
    expect(logged).toContain('/lab/work-items/accept-ehr-order');
    expect(logged).not.toContain(secret);
  });

  it('logs no database refusal for a domain problem without a database cause', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    respond(new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Lab order acceptance conflicts with existing work'),
      '/lab/work-items/accept-ehr-order');
    respond(new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used for different Lab evidence', undefined,
      { cause: Object.assign(new Error(secret), { code: 'ECONNRESET' }) }), '/lab/imports');
    expect(warn).not.toHaveBeenCalled();
  });
});
