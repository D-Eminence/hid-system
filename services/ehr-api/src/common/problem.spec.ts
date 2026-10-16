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
  it('answers Retry-After only for a whole positive number of seconds a problem names', () => {
    const request = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ', method: 'POST', route: { path: '/ehr/me/chat' } } as
      unknown as HidRequest;
    const respond = (problem: DomainProblem) => {
      const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(), setHeader: jest.fn() } as unknown as Response;
      const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as
        unknown as ArgumentsHost;
      new ProblemDetailsFilter().catch(problem, host);
      return response;
    };
    const limited = respond(new DomainProblem(429, 'RECORD_CHAT_RATE_LIMITED', 'Limit reached', undefined, undefined, 1800));
    expect(limited.setHeader).toHaveBeenCalledWith('Retry-After', '1800');
    expect(limited.status).toHaveBeenCalledWith(429);
    expect((limited.json as jest.Mock).mock.calls[0]?.[0]).toMatchObject({ status: 429, code: 'RECORD_CHAT_RATE_LIMITED' });
    for (const seconds of [undefined, 0, -5, 2.5, Number.NaN]) {
      expect(respond(new DomainProblem(429, 'RATE_LIMITED', 'x', undefined, undefined, seconds)).setHeader)
        .not.toHaveBeenCalled();
    }
  });
});
