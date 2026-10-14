import { type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { IdentityActorContext } from '@hid/api-client';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { AuditInterceptor } from './audit.interceptor';
import type { AuditService } from './audit.service';

// A17: EHR's AuditInterceptor recorded the client's purpose query parameter
// or X-Purpose-Of-Use header for a patient session too, so a patient's own
// request sent with `direct-care` was audited as direct care. A patient
// session's rows record purpose `patient-self`, as the patient's own records
// read already does (patient-records.service.ts); a staff request keeps the
// purpose it declares. Status, code and outcome are as before (A17-EHR-AUDIT).

const DEFAULT_FACILITY = { id: '30000000-0000-4000-8000-000000000001', membershipId: '40000000-0000-4000-8000-000000000001',
  organizationId: '50000000-0000-4000-8000-000000000001', name: 'Lagos General', roles: ['clinician'],
  permissions: ['ehr.encounter.read'], isPrimary: true };
const staff: IdentityActorContext = { kind: 'staff', id: 'staff:s', subject: 'staff:s', accountId: '20000000-0000-4000-8000-0000000000b1',
  roles: ['clinician'], permissions: ['ehr.encounter.read'], platformRoles: [], platformPermissions: [],
  facilityIds: [DEFAULT_FACILITY.id], facilities: [DEFAULT_FACILITY], facility: DEFAULT_FACILITY, role: 'clinician',
  authenticationMethod: 'local' };
const patient: IdentityActorContext = { kind: 'patient', patientId: '60000000-0000-4000-8000-000000000001', id: 'patient:p',
  subject: 'patient:p', accountId: '20000000-0000-4000-8000-0000000000c1', sessionId: '90000000-0000-4000-8000-0000000000c1',
  roles: [], permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' };

interface Shape {
  actor?: IdentityActorContext; facilityId?: string; method?: string; path?: string;
  headers?: Record<string, string>; query?: Record<string, string>; metadata?: Map<symbol, unknown>;
}

function intercept(shape: Shape, handler: CallHandler) {
  const lower = Object.fromEntries(Object.entries(shape.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const request = { method: shape.method ?? 'GET', correlationId: 'audit-interceptor-test', ip: '127.0.0.1',
    route: { path: shape.path ?? '/api/v1/ehr/me/records' }, query: shape.query ?? {}, params: {}, actor: shape.actor,
    facilityId: shape.facilityId, header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
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

describe('EHR AuditInterceptor records a patient session\'s purpose as patient-self (A17)', () => {
  it.each([
    ['X-Purpose-Of-Use direct-care', { headers: { 'X-Purpose-Of-Use': 'direct-care' } }],
    ['the purpose query parameter emergency', { query: { purpose: 'emergency' } }],
  ])('records patient-self on a refused GET /ehr/me/records sent with %s', async (_case, sent) => {
    const { audit, result } = intercept({ actor: patient, metadata: new Map([[AUDIT_FAILURES_ONLY, true]]), ...sent },
      failing(new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed')));
    await expect(result).rejects.toBeInstanceOf(DomainProblem);
    const row = recorded(audit);
    expect(row).toMatchObject({ actorType: 'patient', action: 'api.get./api/v1/ehr/me/records', resourceType: 'http-request',
      purposeOfUse: 'patient-self' });
    expect(row.details).toEqual({ method: 'GET', route: '/api/v1/ehr/me/records', status: 403, code: 'PATIENT_ACCESS_DENIED',
      durationMs: expect.any(Number) });
  });

  it('records patient-self on a patient\'s success row, with no purpose sent', async () => {
    const { audit, result } = intercept({ actor: patient, metadata: new Map([[AUDIT_ACTION, 'ehr.patient.self.probe']]) },
      succeeding);
    await expect(result).resolves.toEqual({ ok: true });
    expect(recorded(audit)).toMatchObject({ actorType: 'patient', action: 'api.ehr.patient.self.probe', outcome: 'success',
      purposeOfUse: 'patient-self' });
  });

  it.each([
    ['a success', succeeding],
    ['a refusal', failing(new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing'))],
  ])('still records the purpose a staff request declares on %s (regression pin)', async (_case, handler) => {
    const { audit, result } = intercept({ actor: staff, facilityId: DEFAULT_FACILITY.id, path: '/api/v1/ehr/encounters',
      headers: { 'X-Purpose-Of-Use': 'direct-care' } }, handler);
    await result.catch(() => undefined);
    expect(recorded(audit)).toMatchObject({ facilityId: DEFAULT_FACILITY.id, purposeOfUse: 'direct-care' });
  });
});
