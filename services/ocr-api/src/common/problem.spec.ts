import { Logger, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { HidRequest } from './request-context';
import { DomainProblem, ProblemDetailsFilter } from './problem';

describe('ProblemDetailsFilter refusal logging', () => {
  const patientId = '50000000-0000-4000-8000-000000000001';
  const documentId = '60000000-0000-4000-8000-000000000002';
  const detailText = 'Fictional refusal detail mentioning Ada Example';

  function hostFor(request: HidRequest) {
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ArgumentsHost;
    return { host, response };
  }

  beforeEach(() => jest.restoreAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('logs one warning with only the code, status, method, route template and correlation id', () => {
    const request = {
      correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ',
      method: 'POST',
      path: `/api/v1/ocr/jobs/${patientId}/${documentId}`,
      url: `/api/v1/ocr/jobs/${patientId}/${documentId}?q=${patientId}`,
      originalUrl: `/api/v1/ocr/jobs/${patientId}/${documentId}?q=${patientId}`,
      params: { patientId, documentId },
      query: { q: patientId },
      body: { patientId, documentId, note: detailText },
      headers: { authorization: 'Bearer fictional-token', 'x-patient': patientId },
      route: { path: '/ocr/jobs' },
    } as unknown as HidRequest;
    const { host, response } = hostFor(request);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    new ProblemDetailsFilter().catch(new DomainProblem(403, 'FICTIONAL_REFUSAL', detailText), host);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      message: 'Request refused',
      correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ',
      status: 403,
      code: 'FICTIONAL_REFUSAL',
      method: 'POST',
      route: '/ocr/jobs',
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(detailText);
    expect(logged).not.toContain('Ada Example');
    expect(logged).not.toContain(patientId);
    expect(logged).not.toContain(documentId);
    expect(logged).not.toContain('/api/v1/ocr/jobs');
    expect(logged).not.toContain('fictional-token');
  });

  it('logs the default code and an unresolved route for a plain 404', () => {
    const request = { correlationId: 'corr-404', method: 'GET' } as unknown as HidRequest;
    const { host } = hostFor(request);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    new ProblemDetailsFilter().catch(new NotFoundException(`No row ${documentId}`), host);

    expect(warn.mock.calls[0]?.[0]).toEqual({
      message: 'Request refused',
      correlationId: 'corr-404',
      status: 404,
      code: 'NOT_FOUND',
      method: 'GET',
      route: 'unresolved',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(documentId);
  });

  it('does not warn for a server failure', () => {
    const request = { correlationId: 'corr-500', method: 'GET', route: { path: '/ocr/jobs' } } as unknown as HidRequest;
    const { host } = hostFor(request);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    new ProblemDetailsFilter().catch(new Error('fictional failure'), host);

    expect(warn).not.toHaveBeenCalled();
  });
});
