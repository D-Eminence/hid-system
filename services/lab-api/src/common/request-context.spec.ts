import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { DomainProblem, ProblemDetailsFilter } from './problem';
import { requireRequestContext, type HidRequest } from './request-context';

// Lab reads take the purpose from X-Purpose-Of-Use, which the security guard
// does not check. A missing or unknown purpose is the client's error and
// answers 400; a request without the credentials the guard requires, or one the
// guard did not establish, stays an internal error.

const facilityId = '10000000-0000-4000-8000-000000000002';
const actor = { id: 'staff:lab', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001',
  roles: ['lab'], permissions: ['lab.work-item.read'], facilityIds: [facilityId], authenticationMethod: 'local' as const,
  facilities: [], facility: { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: facilityId, name: 'Facility', roles: ['lab'], permissions: ['lab.work-item.read'], isPrimary: true } };

function guardedRequest(headers: Record<string, string | undefined>, established = true): HidRequest {
  const lower = Object.fromEntries(Object.entries({ authorization: 'Bearer synthetic', ...headers })
    .map(([name, value]) => [name.toLowerCase(), value]));
  return { method: 'GET', correlationId: 'correlation-lab-purpose-0001',
    ...(established ? { actor, facilityId } : {}),
    route: { path: '/lab/work-items/:workItemId' },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('requireRequestContext did not throw');
}

describe('Lab request context purpose of use', () => {
  it.each([
    { name: 'no X-Purpose-Of-Use header', headers: {} },
    { name: 'an unknown purpose', headers: { 'x-purpose-of-use': 'treatment' } },
    { name: 'a purpose in another case', headers: { 'x-purpose-of-use': 'Direct-Care' } },
    { name: 'a cookie session without a purpose', headers: { authorization: undefined, cookie: 'hid_access=synthetic' } },
  ])('answers 400 PURPOSE_OF_USE_REQUIRED for $name', ({ headers }) => {
    const request = guardedRequest(headers);
    const problem = thrown(() => requireRequestContext(request));
    expect(problem).toBeInstanceOf(DomainProblem);
    expect([(problem as DomainProblem).getStatus(), (problem as DomainProblem).code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    expect(request.purposeOfUse).toBeUndefined();
  });

  it.each(['direct-care', 'emergency', 'healthcare-operations'])('accepts the header purpose %s', (purpose) => {
    const request = guardedRequest({ 'x-purpose-of-use': purpose });
    expect(requireRequestContext(request)).toMatchObject({ purposeOfUse: purpose, facilityId,
      authorization: 'Bearer synthetic', correlationId: 'correlation-lab-purpose-0001' });
    expect(request.purposeOfUse).toBe(purpose);
  });

  it('takes a validated body purpose over the header', () => {
    expect(requireRequestContext(guardedRequest({ 'x-purpose-of-use': 'treatment' }), 'direct-care').purposeOfUse)
      .toBe('direct-care');
  });

  it.each([
    { name: 'without the bearer token or cookie the guard requires', request: () =>
      guardedRequest({ authorization: undefined, 'x-purpose-of-use': 'direct-care' }) },
    { name: 'the guard did not establish', request: () => guardedRequest({ 'x-purpose-of-use': 'direct-care' }, false) },
  ])('keeps a request $name an internal error', ({ request }) => {
    const error = thrown(() => requireRequestContext(request()));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DomainProblem);
  });

  it('renders the refusal as a 400 problem and logs no server error', () => {
    const request = guardedRequest({});
    const problem = thrown(() => requireRequestContext(request));
    const json = jest.fn();
    const type = jest.fn(() => ({ json }));
    const status = jest.fn(() => ({ type }));
    const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      new ProblemDetailsFilter().catch(problem, host);
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 400, code: 'PURPOSE_OF_USE_REQUIRED',
        detail: 'X-Purpose-Of-Use must be direct-care, emergency or healthcare-operations' }));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
