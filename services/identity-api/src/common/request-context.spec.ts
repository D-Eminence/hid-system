import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { NinRegistrationController } from '../identity/nin-registration.controller';
import type { NinRegistrationService } from '../identity/nin-registration.service';
import { DomainProblem, ProblemDetailsFilter } from './problem';
import { requireRequestContext, type HidRequest } from './request-context';

// The registration-case read takes the purpose from X-Purpose-Of-Use, which the
// security guard does not check (consent and audit routes check it first
// themselves; the other routes supply a validated body purpose). A missing or
// unknown purpose is the client's error and answers 400, while a request the
// guard did not establish stays an internal error.

const facilityId = '10000000-0000-4000-8000-000000000002';
const actor = { id: 'staff:registrar', subject: 'staff:registrar', accountId: '20000000-0000-4000-8000-000000000001',
  roles: ['registrar'], permissions: ['identity.registration.write'], facilityIds: [facilityId],
  authenticationMethod: 'local' as const, facilities: [],
  facility: { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001', organizationId: facilityId,
    name: 'Facility', roles: ['registrar'], permissions: ['identity.registration.write'], isPrimary: true } };

function guardedRequest(headers: Record<string, string | undefined>, established = true): HidRequest {
  const lower = Object.fromEntries(Object.entries({ authorization: 'Bearer synthetic', ...headers })
    .map(([name, value]) => [name.toLowerCase(), value]));
  return { method: 'GET', correlationId: 'correlation-identity-purpose-0001',
    ...(established ? { actor, facilityId } : {}),
    route: { path: '/api/v1/identity/registration-cases/:caseId' },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('The call did not throw');
}

function purposeRefusal(run: () => unknown): DomainProblem {
  const caught = thrown(run);
  expect(caught).toBeInstanceOf(DomainProblem);
  return caught as DomainProblem;
}

describe('Identity request context purpose of use', () => {
  it.each([
    { name: 'no X-Purpose-Of-Use header', headers: {} },
    { name: 'an empty X-Purpose-Of-Use header', headers: { 'x-purpose-of-use': '' } },
    { name: 'an unknown purpose', headers: { 'x-purpose-of-use': 'treatment' } },
    { name: 'a purpose in another case', headers: { 'x-purpose-of-use': 'Direct-Care' } },
  ])('answers 400 PURPOSE_OF_USE_REQUIRED for $name', ({ headers }) => {
    const request = guardedRequest(headers);
    const problem = purposeRefusal(() => requireRequestContext(request));
    expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    expect(request.purposeOfUse).toBeUndefined();
  });

  it.each(['direct-care', 'emergency', 'healthcare-operations'])('accepts the header purpose %s', (purpose) => {
    const request = guardedRequest({ 'x-purpose-of-use': purpose });
    expect(requireRequestContext(request)).toMatchObject({ purposeOfUse: purpose, facilityId,
      membershipId: actor.facility.membershipId, correlationId: 'correlation-identity-purpose-0001',
      authorization: 'Bearer synthetic' });
    expect(request.purposeOfUse).toBe(purpose);
  });

  it('takes a supplied purpose over the header', () => {
    expect(requireRequestContext(guardedRequest({ 'x-purpose-of-use': 'treatment' }), 'direct-care').purposeOfUse)
      .toBe('direct-care');
  });

  it('keeps a request the guard did not establish an internal error, not a client error', () => {
    const error = thrown(() => requireRequestContext(guardedRequest({ 'x-purpose-of-use': 'direct-care' }, false)));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DomainProblem);
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
        correlationId: 'correlation-identity-purpose-0001',
        detail: 'X-Purpose-Of-Use must be direct-care, emergency or healthcare-operations' }));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe('Identity registration-case read refuses a missing purpose before reading', () => {
  it('GET /identity/registration-cases/:caseId answers 400 PURPOSE_OF_USE_REQUIRED without a purpose', () => {
    const registrations = { getCase: jest.fn() };
    const routes = new NinRegistrationController(registrations as unknown as NinRegistrationService);
    const problem = purposeRefusal(() => routes.getCase('70000000-0000-4000-8000-000000000001', guardedRequest({})));
    expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    expect(registrations.getCase).not.toHaveBeenCalled();
  });
});
