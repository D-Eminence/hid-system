import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { OcrController, OcrPublicationController } from '../ocr/ocr.controller';
import type { OcrService } from '../ocr/ocr.service';
import { DomainProblem, ProblemDetailsFilter } from './problem';
import { requireRequestContext, type HidRequest } from './request-context';

// The read routes take the purpose from X-Purpose-Of-Use, which the security
// guard does not check; the write routes take it from their validated body.
// A missing or unknown purpose is the client's error and answers 400, while a
// request the guard did not establish stays an internal error.

const facilityId = '10000000-0000-4000-8000-000000000002';
const actor = { id: 'staff:records', subject: 'staff:records', accountId: '20000000-0000-4000-8000-000000000001',
  roles: ['records'], permissions: ['ocr.job.read'], facilityIds: [facilityId], authenticationMethod: 'local' as const,
  facilities: [], facility: { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: facilityId, name: 'Facility', roles: ['records'], permissions: ['ocr.job.read'], isPrimary: true } };

function guardedRequest(headers: Record<string, string | undefined>, established = true): HidRequest {
  const lower = Object.fromEntries(Object.entries({ authorization: 'Bearer synthetic', ...headers })
    .map(([name, value]) => [name.toLowerCase(), value]));
  return { method: 'GET', correlationId: 'correlation-purpose-0001',
    ...(established ? { actor, facilityId } : {}),
    route: { path: '/api/v1/ocr/jobs/:jobId' },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function purposeRefusal(run: () => unknown): DomainProblem {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(DomainProblem);
  return caught as DomainProblem;
}

describe('OCR request context purpose of use', () => {
  it.each([
    { name: 'no X-Purpose-Of-Use header', headers: {} },
    { name: 'an empty X-Purpose-Of-Use header', headers: { 'x-purpose-of-use': '' } },
    { name: 'an unknown purpose', headers: { 'x-purpose-of-use': 'treatment' } },
    { name: 'a purpose in another case', headers: { 'x-purpose-of-use': 'Direct-Care' } },
  ])('answers 400 PURPOSE_OF_USE_REQUIRED for $name', ({ headers }) => {
    const request = guardedRequest(headers);
    const problem = purposeRefusal(() => requireRequestContext(request));
    expect(problem.getStatus()).toBe(400);
    expect(problem.code).toBe('PURPOSE_OF_USE_REQUIRED');
    expect(request.purposeOfUse).toBeUndefined();
  });

  it.each(['direct-care', 'emergency', 'healthcare-operations'])('accepts the header purpose %s', (purpose) => {
    const request = guardedRequest({ 'x-purpose-of-use': purpose });
    expect(requireRequestContext(request)).toMatchObject({ purposeOfUse: purpose, facilityId,
      membershipId: actor.facility.membershipId, correlationId: 'correlation-purpose-0001' });
    expect(request.purposeOfUse).toBe(purpose);
  });

  it('takes a validated body purpose over the header', () => {
    const request = guardedRequest({ 'x-purpose-of-use': 'treatment' });
    expect(requireRequestContext(request, 'direct-care').purposeOfUse).toBe('direct-care');
  });

  it('keeps a request the guards did not establish an internal error, not a client error', () => {
    let caught: unknown;
    try { requireRequestContext(guardedRequest({ 'x-purpose-of-use': 'direct-care' }, false)); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DomainProblem);
  });

  it('renders the refusal as a 400 problem and logs no server error', () => {
    const request = guardedRequest({});
    const problem = purposeRefusal(() => requireRequestContext(request));
    const json = jest.fn();
    const type = jest.fn(() => ({ json }));
    const status = jest.fn(() => ({ type }));
    const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      new ProblemDetailsFilter().catch(problem, host);
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 400, code: 'PURPOSE_OF_USE_REQUIRED',
        correlationId: 'correlation-purpose-0001',
        detail: 'X-Purpose-Of-Use must be direct-care, emergency or healthcare-operations' }));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe('OCR read routes refuse a missing purpose before reading', () => {
  const id = '70000000-0000-4000-8000-000000000001';
  const service = { getJob: jest.fn(), findForDocument: jest.fn(), listExtractions: jest.fn(),
    listValidations: jest.fn(), listPublications: jest.fn() };
  const jobs = new OcrController(service as unknown as OcrService);
  const publications = new OcrPublicationController(service as unknown as OcrService);

  it.each([
    { route: 'GET /ocr/jobs/:jobId', read: (request: HidRequest) => jobs.get(id, request) },
    { route: 'GET /ocr/jobs?documentId=', read: (request: HidRequest) => jobs.find({ documentId: id }, request) },
    { route: 'GET /ocr/jobs/:jobId/extractions', read: (request: HidRequest) => jobs.extractions(id, request) },
    { route: 'GET /ocr/jobs/:jobId/validations', read: (request: HidRequest) => jobs.validations(id, request) },
    { route: 'GET /ocr/validations/:validationId/publications',
      read: (request: HidRequest) => publications.list(id, request) },
  ])('$route answers 400 PURPOSE_OF_USE_REQUIRED without a purpose', ({ read }) => {
    const problem = purposeRefusal(() => read(guardedRequest({})));
    expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });
});
