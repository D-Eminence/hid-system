import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IdentityActorContext } from '@hid/api-client';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityApiService } from '../integrations/identity-api.service';
import { RemoteSecurityGuard } from './remote-security.guard';

// A16: a platform administration grant exempted that person's clinical staff
// session from maintenance mode and the provider portal switch, so an
// administrator kept reading and writing records during a maintenance window
// or a portal shutdown. Platform sessions never authenticate at EHR, so no
// EHR request is exempt.

const facility = { id: '30000000-0000-4000-8000-000000000001', membershipId: '40000000-0000-4000-8000-000000000001',
  organizationId: '50000000-0000-4000-8000-000000000001', name: 'Lagos General', roles: ['doctor'],
  permissions: ['ehr.encounter.read'], isPrimary: true };
const administratorsClinicalSession: IdentityActorContext = { kind: 'staff', id: 'staff:a', subject: 'staff:a',
  accountId: '20000000-0000-4000-8000-0000000000a1', roles: ['doctor'], permissions: ['ehr.encounter.read'],
  platformRoles: ['platform_super_admin'], platformPermissions: ['platform.admin.access', 'platform.control.manage'],
  facilityIds: [facility.id], facilities: [facility], facility, role: 'doctor', authenticationMethod: 'local' };

function guardWith(controls: Record<string, boolean>) {
  const identity = { authenticateRequest: jest.fn().mockResolvedValue(administratorsClinicalSession) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const database = { query: jest.fn(async (_sql: string, values: unknown[]) =>
    ({ rows: [{ enabled: controls[values[0] as string] === true }], rowCount: 1 })) };
  return new RemoteSecurityGuard(new Reflector(), identity as unknown as IdentityApiService,
    audit as unknown as AuditService, database as unknown as DatabaseService);
}

function context(): ExecutionContext {
  const headers: Record<string, string> = { 'x-facility-id': facility.id, cookie: 'hid_access=opaque' };
  const request = { method: 'GET', correlationId: 'platform-grant-runtime-controls', ip: '127.0.0.1',
    route: { path: '/ehr/encounters' }, header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => function encounters() { return undefined; }, getClass: () => class EncountersProbe {},
  } as unknown as ExecutionContext;
}

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

describe('EHR runtime controls apply to every clinical session, platform grant or not (A16)', () => {
  it('answers a platform administrator\'s clinical session 503 PLATFORM_MAINTENANCE in maintenance mode', async () => {
    const problem = await refusal(guardWith({ maintenance_mode: true, provider_portal_enabled: true })
      .canActivate(context()));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'PLATFORM_MAINTENANCE']);
  });

  it('answers it 423 PLATFORM_PORTAL_DISABLED while the provider portal is disabled', async () => {
    const problem = await refusal(guardWith({ maintenance_mode: false, provider_portal_enabled: false })
      .canActivate(context()));
    expect([problem.getStatus(), problem.code]).toEqual([423, 'PLATFORM_PORTAL_DISABLED']);
  });

  it('admits it when the platform is open', async () => {
    await expect(guardWith({ maintenance_mode: false, provider_portal_enabled: true }).canActivate(context()))
      .resolves.toBe(true);
  });
});
