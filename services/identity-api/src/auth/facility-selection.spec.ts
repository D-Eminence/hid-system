jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(),
  SignJWT: class {
    setProtectedHeader() { return this; } setSubject() { return this; }
    setIssuer() { return this; } setAudience() { return this; }
    setJti() { return this; } setIssuedAt() { return this; }
    setExpirationTime() { return this; } async sign() { return 'signed-access-token'; }
  },
}));

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { FACILITY_OPTIONAL, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentPatientContextService } from './current-patient-context.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { SecurityGuard } from './security.guard';
import { TokenService } from './token.service';

const sessionId = '70000000-0000-4000-8000-000000000001';
const first: FacilityAssignment = {
  id: '10000000-0000-4000-8000-000000000001',
  membershipId: '20000000-0000-4000-8000-000000000001',
  organizationId: '30000000-0000-4000-8000-000000000001',
  name: 'First Hospital', roles: ['doctor'], permissions: ['ehr.encounter.read'], isPrimary: true,
};
const second: FacilityAssignment = {
  id: '10000000-0000-4000-8000-000000000002',
  membershipId: '20000000-0000-4000-8000-000000000002',
  organizationId: '30000000-0000-4000-8000-000000000002',
  name: 'Second Laboratory', roles: ['lab_technician'], permissions: ['lab.results.read'], isPrimary: false,
};
const unrelatedFacilityId = '10000000-0000-4000-8000-000000000003';
const event = { correlationId: 'facility-selection-test-0001', sourceIp: '203.0.113.10' };

function actor(facilities: FacilityAssignment[] = [first, second], selected = first): ActorContext {
  return {
    id: 'staff:two-facilities', subject: 'staff:two-facilities',
    accountId: '40000000-0000-4000-8000-000000000001', sessionId,
    authenticationMethod: 'local', roles: selected.roles, permissions: selected.permissions,
    platformRoles: [], platformPermissions: [], facilityIds: facilities.map((facility) => facility.id),
    facilities, facility: selected,
  };
}

function harness() {
  const state = { selectedFacilityId: first.id, secondMembershipActive: true, sessionActive: true };
  const clientQuery = jest.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes('update auth.sessions session') && sql.includes('selected_facility_id')) {
      if (!state.sessionActive || values?.[2] === second.id && !state.secondMembershipActive) {
        return { rows: [], rowCount: 0 };
      }
      state.selectedFacilityId = String(values?.[2]);
      return { rows: [{ id: sessionId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('session.refresh_token_sha256')) {
      const tomorrow = new Date(Date.now() + 86_400_000);
      return { rows: [{ id: sessionId,
        account_id: '40000000-0000-4000-8000-000000000001',
        actor_subject: 'staff:two-facilities', family_id: sessionId,
        access_jti: '80000000-0000-4000-8000-000000000001', token_version: '1',
        authentication_method: 'password', session_kind: 'staff', patient_id: null,
        selected_facility_id: state.selectedFacilityId,
        expires_at: tomorrow, absolute_expires_at: tomorrow, revoked_at: null }], rowCount: 1 };
    }
    if (sql.includes('session.selected_facility_id::text')) {
      return { rows: [{ selected_facility_id: state.selectedFacilityId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const database = { query,
    withSystemTransaction: jest.fn(async (_correlationId: string,
      work: (client: PoolClient) => Promise<unknown>) => work({ query: clientQuery } as unknown as PoolClient)),
  } as unknown as DatabaseService;
  const resolve = jest.fn(async (_subject: string, _method: string, requestedSession?: string,
    preferredFacilityId?: string) => {
    const eligible = state.secondMembershipActive ? [first, second] : [first];
    const selected = eligible.find((facility) => facility.id === preferredFacilityId) ?? first;
    return { ...actor(eligible, selected), sessionId: requestedSession };
  });
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined),
    record: jest.fn().mockResolvedValue(undefined) };
  const service = new TokenService(database,
    { resolve } as unknown as CurrentStaffContextService,
    {} as CurrentPatientContextService, audit as unknown as AuditService);
  return { service, state, clientQuery, query, database, resolve, audit };
}

function verifiedClaims() {
  jest.mocked(jwtVerify).mockResolvedValue({ payload: {
    sub: 'staff:two-facilities', sid: sessionId,
    jti: '80000000-0000-4000-8000-000000000001',
    auth_method: 'local', actor_kind: 'staff', token_version: 1,
  } } as never);
}

describe('staff facility selection', () => {
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    resetEnvironmentForTests();
    jest.clearAllMocks();
  });
  afterEach(() => resetEnvironmentForTests());

  it('persists the single authorized facility and audits it in the same transaction', async () => {
    const { service, state, clientQuery, database, audit } = harness();
    await service.selectFacility(actor([first]), first.id, event);
    expect(state.selectedFacilityId).toBe(first.id);
    expect(database.withSystemTransaction).toHaveBeenCalledTimes(1);
    const [sql, args] = clientQuery.mock.calls[0] ?? [];
    expect(sql).toContain("session.session_kind = 'staff'");
    expect(sql).toContain('membership.id = $6');
    expect(sql).toContain('membership.migration_hold_reason is null');
    expect(args).toEqual([sessionId, actor().accountId, first.id, actor().subject,
      ['verified', 'approved', 'active'], first.membershipId]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      action: 'auth.facility.select', facilityId: first.id, actorMembershipId: first.membershipId,
    }));
  });

  it('switches between two facilities and restores the selection on session bootstrap', async () => {
    const { service, state, resolve, audit } = harness();
    verifiedClaims();
    await service.selectFacility(actor(), second.id, event);
    expect(state.selectedFacilityId).toBe(second.id);
    const restored = await service.verify('signed-access-token');
    expect(restored.actor.facility?.id).toBe(second.id);
    expect(restored.actor.permissions).toEqual(['lab.results.read']);
    expect(resolve).toHaveBeenCalledWith(actor().subject, 'local', sessionId, second.id);
    await service.selectFacility(restored.actor, first.id, event);
    expect((await service.verify('signed-access-token')).actor.facility?.id).toBe(first.id);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(2);
  });

  it('carries the revalidated selection into a rotated refresh session', async () => {
    const { service, clientQuery, resolve } = harness();
    await service.selectFacility(actor(), second.id, event);
    const result = await service.refresh(`${sessionId}.refresh-secret.local`, event);
    expect(result.actor.facility?.id).toBe(second.id);
    expect(resolve).toHaveBeenCalledWith(actor().subject, 'local', undefined, second.id);
    const inserted = clientQuery.mock.calls.find(([sql]) => sql.includes('insert into auth.sessions'));
    expect(inserted?.[1]?.[12]).toBe(second.id);
  });

  it('falls back to a live facility after selected membership is revoked', async () => {
    const { service, state, resolve, clientQuery } = harness();
    await service.selectFacility(actor(), second.id, event);
    state.secondMembershipActive = false;
    verifiedClaims();
    const verified = await service.verify('signed-access-token');
    expect(verified.actor.facility?.id).toBe(first.id);
    expect(verified.actor.facilityIds).toEqual([first.id]);
    const refreshed = await service.refresh(`${sessionId}.refresh-secret.local`, event);
    expect(refreshed.actor.facility?.id).toBe(first.id);
    const inserted = clientQuery.mock.calls.find(([sql]) => sql.includes('insert into auth.sessions'));
    expect(inserted?.[1]?.[12]).toBe(first.id);
    expect(resolve).toHaveBeenCalledWith(actor().subject, 'local', sessionId, second.id);
  });

  it('denies unassigned or newly inactive facilities without writing an audit success', async () => {
    const { service, state, database, audit } = harness();
    await expect(service.selectFacility(actor(), unrelatedFacilityId, event))
      .rejects.toMatchObject({ code: 'FACILITY_ACCESS_DENIED' });
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    state.secondMembershipActive = false;
    await expect(service.selectFacility(actor(), second.id, event))
      .rejects.toMatchObject({ code: 'FACILITY_ACCESS_DENIED' });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('rejects an external OIDC bearer without a HID session; an internal OIDC session can select', async () => {
    const { service, database } = harness();
    await expect(service.selectFacility({ ...actor(), sessionId: undefined,
      authenticationMethod: 'oidc' }, second.id, event))
      .rejects.toMatchObject({ code: 'FACILITY_SESSION_REQUIRED' });
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    await expect(service.selectFacility({ ...actor(), authenticationMethod: 'oidc' }, second.id, event))
      .resolves.toBeUndefined();
  });

  it('keeps provider operations scoped to the exact authorized facility header', async () => {
    const staff = { ...actor(), platformPermissions: ['platform.admin.access'] };
    const tokens = { verify: jest.fn().mockResolvedValue({ actor: staff, claims: {} }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const guard: CanActivate = new SecurityGuard(
      { getAllAndOverride: jest.fn() } as unknown as Reflector,
      tokens as unknown as TokenService, audit as unknown as AuditService,
      { query: jest.fn() } as unknown as DatabaseService);
    const requestFor = (facilityId: string) => ({ method: 'GET', correlationId: event.correlationId,
      header: (name: string) => name === 'authorization' ? 'Bearer signed'
        : name === 'x-facility-id' ? facilityId : undefined } as unknown as HidRequest);
    const contextFor = (request: HidRequest) => ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}), getClass: () => ({}),
    } as unknown as ExecutionContext);
    const secondRequest = requestFor(second.id);
    await expect(guard.canActivate(contextFor(secondRequest))).resolves.toBe(true);
    expect(secondRequest.actor?.facility?.id).toBe(second.id);
    expect(secondRequest.actor?.permissions).toEqual(['lab.results.read']);
    await expect(guard.canActivate(contextFor(requestFor(unrelatedFacilityId))))
      .rejects.toMatchObject({ code: 'FACILITY_ACCESS_DENIED' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });

  it('allows a facility-free platform administrator through a facility-optional admin route', async () => {
    const platformAdmin: ActorContext = {
      ...actor(), roles: [], permissions: [], facilityIds: [], facilities: [], facility: undefined,
      platformRoles: ['platform_super_admin'], platformPermissions: ['platform.admin.access'],
    };
    const tokens = { verify: jest.fn().mockResolvedValue({ actor: platformAdmin, claims: {} }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const reflector = { getAllAndOverride: jest.fn((key: symbol) => {
      if (key === FACILITY_OPTIONAL) return true;
      if (key === REQUIRED_PERMISSIONS) return ['platform.admin.access'];
      return undefined;
    }) };
    const guard: CanActivate = new SecurityGuard(
      reflector as unknown as Reflector,
      tokens as unknown as TokenService, audit as unknown as AuditService,
      { query: jest.fn() } as unknown as DatabaseService);
    const request = { method: 'GET', correlationId: event.correlationId,
      header: (name: string) => name === 'authorization' ? 'Bearer signed' : undefined } as unknown as HidRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}), getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.facilityId).toBeUndefined();
    expect(request.actor?.facility).toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
