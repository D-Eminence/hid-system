import { type CallHandler, type ExecutionContext, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, AUDIT_SESSION_EVENT } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { StaffSearchBudget } from '../identity/staff-search-budget';
import { platformActor, useTestEnvironment } from '../testing/platform-assurance';
import { AuditInterceptor } from './audit.interceptor';
import type { AuditService } from './audit.service';

// A17: the AuditInterceptor recorded every request that failed after the
// guard with only the method, route and duration: a refused approve (409), a
// validation error (400) and a database fault (500) read the same, and A9's
// facility-less staff row carried the status but no code. Every failure row
// now records the status and code the client is answered
// (problemStatusAndCode), and nothing from the error message. The outcome
// rule is unchanged: an api.* or session-event failure row is `failure`, and
// A9's row is `denied` below 500. A patient session's rows record purpose
// `patient-self`, whatever purpose its client sends.

const facilityA = '10000000-0000-4000-8000-00000000000a';
const membership: FacilityAssignment = {
  id: facilityA, membershipId: '40000000-0000-4000-8000-00000000000a',
  organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A',
  roles: ['doctor'], permissions: ['identity.consent.write'], isPrimary: true,
};
const staff: ActorContext = {
  id: 'staff:provider', subject: 'staff:provider', accountId: '20000000-0000-4000-8000-000000000002',
  sessionId: '90000000-0000-4000-8000-0000000000a2', roles: ['doctor'], permissions: ['identity.consent.write'],
  platformRoles: [], platformPermissions: [], facilityIds: [facilityA], facilities: [membership], facility: membership,
  authenticationMethod: 'local',
};
const patient: ActorContext = {
  ...staff, kind: 'patient', id: 'patient:p', subject: 'patient:p', patientId: '50000000-0000-4000-8000-000000000001',
  facilityIds: [], facilities: [], facility: undefined, roles: [], permissions: [],
};

interface Shape {
  actor?: ActorContext; facilityId?: string; accessScope?: 'facility' | 'platform'; method?: string; path?: string;
  headers?: Record<string, string>; query?: Record<string, string>; metadata?: Map<symbol, unknown>;
}

function intercept(shape: Shape, handler: CallHandler) {
  const lower = Object.fromEntries(Object.entries(shape.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const request = { method: shape.method ?? 'POST', correlationId: 'audit-interceptor-test', ip: '127.0.0.1',
    route: { path: shape.path ?? '/api/v1/identity/test' }, query: shape.query ?? {}, params: {}, actor: shape.actor,
    facilityId: shape.facilityId, accessScope: shape.accessScope ?? 'facility',
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
  const metadata = shape.metadata ?? new Map<symbol, unknown>();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const interceptor = new AuditInterceptor({ getAllAndOverride: (key: symbol) => metadata.get(key) } as unknown as Reflector,
    audit as unknown as AuditService);
  const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
  return { audit, result: lastValueFrom(interceptor.intercept(context, handler)) };
}

const failing = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) });
const succeeding: CallHandler = { handle: () => of({ ok: true }) };
const recorded = (audit: { record: jest.Mock }) => {
  expect(audit.record).toHaveBeenCalledTimes(1);
  return audit.record.mock.calls[0][0] as Record<string, unknown>;
};

const atFacility: Shape = { actor: staff, facilityId: facilityA };

describe('AuditInterceptor failure rows record the answered status and code (A17)', () => {
  it.each([
    ['a refused command', new DomainProblem(409, 'ACCESS_REQUEST_NOT_PENDING', 'The access request is no longer pending'),
      409, 'ACCESS_REQUEST_NOT_PENDING'],
    ['a validation error', new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.'),
      400, 'VALIDATION_FAILED'],
    ['a Nest HTTP refusal', new ForbiddenException('Patient write access is not authorized'), 403, 'ACCESS_DENIED'],
    ['a database fault', new Error('duplicate key value violates unique constraint "patients_nin_key" (nin)=(12345678901)'),
      500, 'INTERNAL_ERROR'],
    ['an unavailable dependency', new ServiceUnavailableException('Audit persistence is unavailable; request was denied'),
      503, 'DEPENDENCY_UNAVAILABLE'],
    ['a paused integration', new DomainProblem(503, 'INTEGRATION_PAUSED', 'Identity verification is temporarily paused'),
      503, 'INTEGRATION_PAUSED'],
  ])('records %s with its status and code, nothing from the message, and rethrows it', async (_case, error, status, code) => {
    const { audit, result } = intercept(atFacility, failing(error));
    await expect(result).rejects.toBe(error);
    const row = recorded(audit);
    // The outcome rule is unchanged (an open owner question, see INTERFACE_CONTRACT.md).
    expect(row).toMatchObject({ action: 'api.post./api/v1/identity/test', resourceType: 'http-request', outcome: 'failure',
      facilityId: facilityA, actorMembershipId: membership.membershipId });
    expect(row.details).toEqual({ method: 'POST', route: '/api/v1/identity/test', status, code, durationMs: expect.any(Number) });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(error.message);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('12345678901');
  });

  describe('with a search budget refusal', () => {
    // The refusal carries Retry-After from the configured window (A21).
    useTestEnvironment();

    it('records a lookup refused while the search budget is blocked (0086) with 429 PATIENT_LOOKUP_RATE_LIMITED',
      async () => {
        // StaffSearchBudget's own refusal, over a database whose budget read says blocked.
        const budget = new StaffSearchBudget({ withTransaction: jest.fn(async () => true) } as unknown as DatabaseService);
        const lookup: CallHandler = { handle: () => defer(() => budget.refuseWhileBlocked('patient_lookup',
          { actor: staff, facilityId: facilityA } as never)) };
        const { audit, result } = intercept({ ...atFacility, path: '/api/v1/identity/patient-lookup',
          metadata: new Map([[AUDIT_ACTION, 'identity.patient.lookup.request']]) }, lookup);
        await expect(result).rejects.toMatchObject({ code: 'PATIENT_LOOKUP_RATE_LIMITED' });
        const row = recorded(audit);
        expect(row).toMatchObject({ action: 'api.identity.patient.lookup.request', facilityId: facilityA });
        expect(row.details).toEqual({ method: 'POST', route: '/api/v1/identity/patient-lookup', status: 429,
          code: 'PATIENT_LOOKUP_RATE_LIMITED', durationMs: expect.any(Number) });
      });
  });

  it('records a refused platform command with platform scope', async () => {
    const { audit, result } = intercept({ actor: { ...platformActor(), permissions: [], facility: undefined },
      accessScope: 'platform', path: '/api/v1/admin/test' },
    failing(new DomainProblem(409, 'APPROVAL_NOT_PENDING', 'The approval is no longer pending')));
    await expect(result).rejects.toBeInstanceOf(DomainProblem);
    const row = recorded(audit);
    expect(row).toMatchObject({ actorType: 'staff', accessScope: 'platform' });
    expect(row.details).toEqual({ method: 'POST', route: '/api/v1/admin/test', status: 409, code: 'APPROVAL_NOT_PENDING',
      durationMs: expect.any(Number) });
  });

  it('records a refused session event with its status and code', async () => {
    const { audit, result } = intercept({ actor: staff, path: '/api/v1/auth/logout',
      metadata: new Map([[AUDIT_SESSION_EVENT, 'auth.logout']]) },
    failing(new DomainProblem(403, 'SESSION_CLIENT_MISMATCH', 'This sign-in belongs to the staff portal')));
    await expect(result).rejects.toBeInstanceOf(DomainProblem);
    const row = recorded(audit);
    expect(row).toMatchObject({ action: 'auth.logout', resourceType: 'session', outcome: 'failure' });
    expect(row.details).toEqual({ method: 'POST', route: '/api/v1/auth/logout', status: 403, code: 'SESSION_CLIENT_MISMATCH',
      durationMs: expect.any(Number) });
  });

  it.each([
    ['refusal', new DomainProblem(403, 'PROBE_REFUSED', 'Refused by the handler'), 'auth.authorization.denied', 'denied',
      403, 'PROBE_REFUSED'],
    ['fault', new Error('handler fault with internal detail'), 'auth.request.failed', 'failure', 500, 'INTERNAL_ERROR'],
  ])('records a facility-less staff handler %s (A9\'s row) with its code too', async (
    _case, error, action, outcome, status, code) => {
    const { audit, result } = intercept({ actor: staff }, failing(error));
    await expect(result).rejects.toBe(error);
    const row = recorded(audit);
    expect(row).toMatchObject({ actorType: 'staff', action, resourceType: 'authentication', outcome });
    expect(row.details).toEqual({ method: 'POST', route: '/api/v1/identity/test', status, code,
      requestAction: 'api.post./api/v1/identity/test', durationMs: expect.any(Number) });
    expect(JSON.stringify(row)).not.toContain(error.message);
  });
});

describe('AuditInterceptor records a patient session\'s purpose as patient-self (A17)', () => {
  const approve: Shape = { actor: patient, path: '/api/v1/identity/access-requests/:requestId/approve',
    metadata: new Map([[AUDIT_ACTION, 'identity.access-request.approve.command']]) };

  it.each([
    ['X-Purpose-Of-Use', { headers: { 'X-Purpose-Of-Use': 'direct-care' } }],
    ['the purpose query parameter', { query: { purpose: 'direct-care' } }],
    ['no purpose', {}],
  ])('records patient-self on an approval sent with %s', async (_case, sent) => {
    const { audit, result } = intercept({ ...approve, ...sent }, succeeding);
    await expect(result).resolves.toEqual({ ok: true });
    const row = recorded(audit);
    expect(row).toMatchObject({ actorType: 'patient', action: 'api.identity.access-request.approve.command',
      outcome: 'success', purposeOfUse: 'patient-self' });
    expect(row.details).toEqual({ method: 'POST', route: '/api/v1/identity/access-requests/:requestId/approve', status: 200,
      durationMs: expect.any(Number) });
  });

  it('records patient-self on a patient\'s refused request on a failures-only route', async () => {
    const { audit, result } = intercept({ actor: patient, method: 'GET', path: '/api/v1/identity/me',
      headers: { 'X-Purpose-Of-Use': 'emergency' }, metadata: new Map([[AUDIT_FAILURES_ONLY, true]]) },
    failing(new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required')));
    await expect(result).rejects.toBeInstanceOf(DomainProblem);
    const row = recorded(audit);
    expect(row).toMatchObject({ actorType: 'patient', purposeOfUse: 'patient-self' });
    expect(row.details).toEqual({ method: 'GET', route: '/api/v1/identity/me', status: 403, code: 'PATIENT_SESSION_REQUIRED',
      durationMs: expect.any(Number) });
  });

  it('records patient-self on a patient\'s session event', async () => {
    const { audit, result } = intercept({ actor: patient, path: '/api/v1/auth/logout', query: { purpose: 'emergency' },
      metadata: new Map([[AUDIT_SESSION_EVENT, 'auth.logout']]) }, succeeding);
    await expect(result).resolves.toEqual({ ok: true });
    expect(recorded(audit)).toMatchObject({ actorType: 'patient', action: 'auth.logout', purposeOfUse: 'patient-self' });
  });

  it('still records the purpose a staff request declares, and no code on a success (regression pin)', async () => {
    const { audit, result } = intercept({ ...atFacility, headers: { 'X-Purpose-Of-Use': 'direct-care' } }, succeeding);
    await expect(result).resolves.toEqual({ ok: true });
    const row = recorded(audit);
    expect(row).toMatchObject({ outcome: 'success', purposeOfUse: 'direct-care' });
    expect(row.details).toEqual({ method: 'POST', route: '/api/v1/identity/test', status: 200, durationMs: expect.any(Number) });
  });

  it('records no purpose for a staff request that declares none (regression pin)', async () => {
    const { audit, result } = intercept(atFacility, succeeding);
    await expect(result).resolves.toEqual({ ok: true });
    expect(recorded(audit).purposeOfUse).toBeUndefined();
  });
});
