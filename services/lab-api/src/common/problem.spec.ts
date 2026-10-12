import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { HidRequest } from './request-context';
import { ProblemDetailsFilter } from './problem';

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

describe('ProblemDetailsFilter database refusals', () => {
  const secret = 'sensitive-row-value-for-patient-50000000';
  const respond = (exception: unknown) => {
    const request = {
      correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ',
      method: 'POST',
      route: { path: '/lab/work-items/accept-ehr-order' },
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
    return (response.json as jest.Mock).mock.calls[0]?.[0] as { status: number; code: string; detail: string };
  };
  const databaseError = (code: string) => Object.assign(new Error(`${secret} violates a guard`), { code });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['23514', 409, 'LAB_STATE_CONFLICT'],
    ['23505', 409, 'LAB_CONFLICT'],
    ['23503', 409, 'LAB_INVALID_REFERENCE'],
    ['42501', 403, 'LAB_ACCESS_DENIED'],
    ['22P02', 400, 'INVALID_LAB_DATA'],
    ['22001', 400, 'INVALID_LAB_DATA'],
    ['23502', 400, 'INVALID_LAB_DATA'],
  ])('answers SQLSTATE %s with %i %s and a fixed detail', (sqlState, status, code) => {
    const problem = respond(databaseError(sqlState));
    expect(problem).toMatchObject({ status, code });
    expect(problem.detail).not.toBe('The request could not be completed.');
    expect(JSON.stringify(problem)).not.toContain(secret);
    expect(JSON.stringify(problem)).not.toContain(sqlState);
  });

  it('logs a mapped refusal with its SQLSTATE and route only', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    respond(databaseError('23514'));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('23514');
    expect(logged).toContain('/lab/work-items/accept-ehr-order');
    expect(logged).not.toContain(secret);
  });

  it('still answers any other database error with 500 INTERNAL_ERROR', () => {
    expect(respond(databaseError('XX000'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR',
      detail: 'The service could not complete the request.' });
    expect(respond(databaseError('P0001'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
});
