import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { HidRequest } from './request-context';
import { DomainProblem, ProblemDetailsFilter, PublicDetailProblem } from './problem';

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
  it('shows a 5xx detail only when the problem was written for the client (PublicDetailProblem)', () => {
    const request = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ', method: 'POST',
      route: { path: '/identity/patient-enrollments' } } as unknown as HidRequest;
    const answer = (exception: unknown) => {
      const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis() } as unknown as Response;
      new ProblemDetailsFilter().catch(exception, { switchToHttp: () => ({
        getRequest: () => request, getResponse: () => response }) } as unknown as ArgumentsHost);
      return (response.json as jest.Mock).mock.calls[0]?.[0] as { status: number; code: string; detail: string };
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(answer(new PublicDetailProblem(503, 'CLOSED_FOR_NOW', 'Written for the patient.')))
      .toMatchObject({ status: 503, code: 'CLOSED_FOR_NOW', detail: 'Written for the patient.' });
    expect(answer(new DomainProblem(503, 'DEPENDENCY_DOWN', 'internal dependency state')))
      .toMatchObject({ status: 503, code: 'DEPENDENCY_DOWN', detail: 'The service could not complete the request.' });
    expect(answer(new PublicDetailProblem(409, 'SOME_CONFLICT', 'A conflict.')))
      .toMatchObject({ status: 409, detail: 'A conflict.' });
  });
});
