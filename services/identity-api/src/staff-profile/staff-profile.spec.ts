jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { type CallHandler, type ExecutionContext, RequestMethod, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, from } from 'rxjs';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  ACCOUNT_ONLY_ALLOWED, AUDIT_ACTION, AuditAction, FACILITY_OPTIONAL, FacilityOptional, NO_AUDIT, PATIENT_ALLOWED,
  PUBLIC_ROUTE, REQUIRED_PERMISSIONS,
} from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { STAFF_PROFILE_AUDIT_ACTION, StaffProfileController } from './staff-profile.controller';
import { licenceNumberHint, STAFF_PROFILE_SQL, StaffProfileService } from './staff-profile.service';

const FACILITY = '30000000-0000-4000-8000-000000000001';
const SECOND_FACILITY = '30000000-0000-4000-8000-000000000002';
const ACCOUNT = '20000000-0000-4000-8000-000000000001';

function facility(id: string, membershipId: string, roles: string[], isPrimary: boolean): FacilityAssignment {
  return { id, membershipId, organizationId: '10000000-0000-4000-8000-000000000001', name: `Fictional Clinic ${id.slice(-1)}`,
    roles, permissions: ['ehr.encounter.read'], isPrimary };
}

const actor: ActorContext = {
  kind: 'staff', id: ACCOUNT, subject: 'staff:fictional-ada', accountId: ACCOUNT, displayName: 'Ada Fictional',
  email: 'ada@example.test', roles: ['doctor'], permissions: ['ehr.encounter.read'], facilityIds: [FACILITY, SECOND_FACILITY],
  facilities: [facility(FACILITY, '40000000-0000-4000-8000-000000000001', ['doctor'], true),
    facility(SECOND_FACILITY, '40000000-0000-4000-8000-000000000002', ['nurse', 'lab'], false)],
  authenticationMethod: 'local', products: ['ehr', 'migrate'],
};

function route(controller: { prototype: object }, name: string) {
  const handler = (controller.prototype as Record<string, unknown>)[name] as object;
  const meta = (key: symbol) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
  return { base: Reflect.getMetadata(PATH_METADATA, controller), path: Reflect.getMetadata(PATH_METADATA, handler),
    method: Reflect.getMetadata(METHOD_METADATA, handler), audit: meta(AUDIT_ACTION), facilityOptional: meta(FACILITY_OPTIONAL),
    noAudit: meta(NO_AUDIT), patientAllowed: meta(PATIENT_ALLOWED), accountOnly: meta(ACCOUNT_ONLY_ALLOWED),
    isPublic: meta(PUBLIC_ROUTE), permissions: meta(REQUIRED_PERMISSIONS) };
}

describe('GET identity/me/staff-profile (SX-5)', () => {
  function setup(row: Record<string, unknown> | undefined) {
    const query = jest.fn().mockResolvedValue({ rows: row ? [row] : [] });
    return { query, service: new StaffProfileService({ query } as unknown as DatabaseService) };
  }
  const row = { account_id: ACCOUNT, display_name: 'Ada Fictional', email: 'ada@example.test',
    password_changed_at: new Date('2026-10-01T09:00:00Z'), has_password: true,
    account_created_at: '2026-01-05T08:00:00Z', full_name: 'Ada N. Fictional', licence_number: 'mdcn/12-345 67' };

  it('is a staff-only read of the caller\'s own account: no permission, facility optional, its own audit row', () => {
    expect(route(StaffProfileController, 'read')).toEqual({ base: 'identity', path: 'me/staff-profile',
      method: RequestMethod.GET, audit: undefined, noAudit: true, facilityOptional: true, patientAllowed: undefined,
      accountOnly: undefined, isPublic: undefined, permissions: undefined });
    expect(STAFF_PROFILE_AUDIT_ACTION).toBe('auth.staff-profile.read');
  });

  it('reads by the session\'s account id and subject together, active accounts only, never the password hash', async () => {
    const s = setup(row);
    await s.service.read(actor, FACILITY);
    expect(s.query).toHaveBeenCalledWith(STAFF_PROFILE_SQL, [ACCOUNT, 'staff:fictional-ada']);
    expect(STAFF_PROFILE_SQL).toMatch(/where account\.id = \$1::uuid\s+and account\.subject = \$2\s+and account\.status = 'active'/);
    expect(STAFF_PROFILE_SQL).not.toMatch(/account\.password_hash(?! is not null)/);
    expect(STAFF_PROFILE_SQL).not.toMatch(/password_algorithm|token_version/);
  });

  it('answers the profile, the facilities from the session and only a hint of the licence number', async () => {
    const s = setup(row);
    const profile = await s.service.read(actor, FACILITY);
    expect(profile).toEqual({
      accountId: ACCOUNT, name: 'Ada Fictional', email: 'ada@example.test',
      signIn: { method: 'password', hasPassword: true, passwordChangedAt: '2026-10-01T09:00:00.000Z' },
      licence: { numberHint: '4567' }, memberSince: '2026-01-05T08:00:00.000Z', currentFacilityId: FACILITY,
      facilities: [
        { id: FACILITY, membershipId: '40000000-0000-4000-8000-000000000001', name: 'Fictional Clinic 1', roles: ['doctor'],
          isPrimary: true, isCurrent: true },
        { id: SECOND_FACILITY, membershipId: '40000000-0000-4000-8000-000000000002', name: 'Fictional Clinic 2',
          roles: ['nurse', 'lab'], isPrimary: false, isCurrent: false },
      ],
      products: ['ehr', 'migrate'],
      canChange: { name: false, password: false, preferences: false },
    });
    expect(JSON.stringify(profile)).not.toContain('12-345');
    expect(JSON.stringify(profile)).not.toMatch(/unverified/i);
  });

  it('falls back to the staff record\'s name, and says when there is no password or licence', async () => {
    const s = setup({ ...row, display_name: '  ', has_password: false, password_changed_at: null, licence_number: null });
    const profile = await s.service.read({ ...actor, authenticationMethod: 'oidc' }, undefined);
    expect(profile).toMatchObject({ name: 'Ada N. Fictional', licence: null, currentFacilityId: null,
      signIn: { method: 'single_sign_on', hasPassword: false, passwordChangedAt: null } });
    expect(profile.facilities.every((entry) => entry.isCurrent === false)).toBe(true);
  });

  it('answers 401 when the account is no longer active', async () => {
    const s = setup(undefined);
    const failure = await s.service.read(actor, FACILITY).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect((failure as DomainProblem).getStatus()).toBe(401);
  });

  it('refuses a patient session even if the guard were bypassed, before any read', async () => {
    const read = jest.fn().mockResolvedValue({});
    const record = jest.fn().mockResolvedValue(undefined);
    const controller = new StaffProfileController({ read } as unknown as StaffProfileService,
      { record } as unknown as AuditService);
    const header = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()];
    await expect(controller.read({ actor: { ...actor, kind: 'patient' }, header: header({}) } as unknown as HidRequest))
      .rejects.toBeInstanceOf(DomainProblem);
    await expect(controller.read({ header: header({}) } as unknown as HidRequest)).rejects.toBeInstanceOf(DomainProblem);
    expect(read).not.toHaveBeenCalled();
    await controller.read({ actor, facilityId: SECOND_FACILITY,
      header: header({ 'x-facility-id': SECOND_FACILITY }) } as unknown as HidRequest);
    expect(read).toHaveBeenCalledWith(actor, SECOND_FACILITY);
  });

  it('shows no licence when the stored number has no letter or digit', async () => {
    for (const licence_number of ['--', '/', '   ']) {
      const profile = await setup({ ...row, licence_number }).service.read(actor, FACILITY);
      expect(profile.licence).toBeNull();
    }
  });

  it('keeps the licence hint rule of identity.licence_number_hint', () => {
    expect(licenceNumberHint('MDCN/12345')).toBe('2345');
    expect(licenceNumberHint('ab-1')).toBe('AB1');
    expect(licenceNumberHint('--')).toBeNull();
    expect(licenceNumberHint(null)).toBeNull();
  });
});

/**
 * The route as served: the real global AuditInterceptor and the real
 * AuditService (its facility rule, assertActorFacility), over a database
 * that only records the insert. A staff 'api.' row on 'http-request' needs a
 * facility, so a facility-optional route audited by the interceptor answers
 * 503 with nothing recorded when no facility is resolved; this route writes
 * its own auth.staff-profile.read row on 'session' instead.
 */
describe('GET identity/me/staff-profile (SX-5) through the audit interceptor and the audit service', () => {
  const row = { account_id: ACCOUNT, display_name: 'Ada Fictional', email: 'ada@example.test',
    password_changed_at: null, has_password: true, account_created_at: '2026-01-05T08:00:00Z', full_name: null,
    licence_number: null };

  class FacilityOptionalInterceptorAudited {
    @AuditAction('identity.facility-optional.read')
    @FacilityOptional()
    read() { return undefined; }
  }

  function served(found: Record<string, unknown> | null = row) {
    const inserts: unknown[][] = [];
    const database = {
      query: jest.fn(async (text: string, values: unknown[] = []) => {
        if (text.includes('insert into audit.events')) { inserts.push(values); return { rows: [] }; }
        return { rows: found ? [found] : [] };
      }),
    } as unknown as DatabaseService;
    const audit = new AuditService(database);
    const controller = new StaffProfileController(new StaffProfileService(database), audit);
    const interceptor = new AuditInterceptor(new Reflector(), audit);
    function run(request: Record<string, unknown>, handler: object = StaffProfileController.prototype.read,
      type: object = StaffProfileController) {
      const headers = (request.headers ?? {}) as Record<string, string>;
      const full = { method: 'GET', correlationId: 'staff-profile-served', route: { path: '/api/v1/identity/me/staff-profile' },
        query: {}, params: {}, ip: '192.0.2.10', ...request, header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
      const context = { getHandler: () => handler, getClass: () => type,
        switchToHttp: () => ({ getRequest: () => full, getResponse: () => ({ statusCode: 200 }) }) } as unknown as ExecutionContext;
      const next: CallHandler = { handle: () => from(type === StaffProfileController ? controller.read(full) : Promise.resolve({})) };
      return firstValueFrom(interceptor.intercept(context, next));
    }
    // values(): 0 correlation, 1 actor type, 4 membership, 6 facility, 8 action, 9 resource type, 11 outcome.
    const rows = () => inserts.map((values) => ({ actorType: values[1], membershipId: values[4], facilityId: values[6],
      action: values[8], resourceType: values[9], outcome: values[11] }));
    return { run, rows };
  }

  it('answers with no X-Facility-ID: currentFacilityId null, every isCurrent false, one success row', async () => {
    const s = served();
    const profile = await s.run({ actor }) as Awaited<ReturnType<StaffProfileService['read']>>;
    expect(profile.currentFacilityId).toBeNull();
    expect(profile.facilities.every((entry) => entry.isCurrent === false)).toBe(true);
    expect(s.rows()).toEqual([{ actorType: 'staff', membershipId: null, facilityId: null,
      action: 'auth.staff-profile.read', resourceType: 'session', outcome: 'success' }]);
  });

  it('answers a platform administrator with no membership', async () => {
    const s = served();
    const admin = { ...actor, facilityIds: [], facilities: [], roles: [], permissions: [],
      platformPermissions: ['platform.admin.access'] } as ActorContext;
    const profile = await s.run({ actor: admin }) as Awaited<ReturnType<StaffProfileService['read']>>;
    expect(profile.facilities).toEqual([]);
    expect(s.rows()).toEqual([expect.objectContaining({ facilityId: null, outcome: 'success' })]);
  });

  it('marks the current facility and records the row at that facility when the header is one of the caller\'s', async () => {
    const s = served();
    const at = actor.facilities[1]!;
    const profile = await s.run({ actor: { ...actor, facility: at }, facilityId: SECOND_FACILITY,
      headers: { 'x-facility-id': SECOND_FACILITY } }) as Awaited<ReturnType<StaffProfileService['read']>>;
    expect(profile.currentFacilityId).toBe(SECOND_FACILITY);
    expect(s.rows()).toEqual([{ actorType: 'staff', membershipId: at.membershipId, facilityId: SECOND_FACILITY,
      action: 'auth.staff-profile.read', resourceType: 'session', outcome: 'success' }]);
  });

  it('refuses 403 FACILITY_ACCESS_DENIED for a facility the caller is not active at, and records the refusal', async () => {
    const s = served();
    // The guard leaves request.facilityId unset for such a header on a facility-optional route.
    const failure = await s.run({ actor, headers: { 'x-facility-id': '30000000-0000-4000-8000-000000000009' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect((failure as DomainProblem).getStatus()).toBe(403);
    expect((failure as DomainProblem).code).toBe('FACILITY_ACCESS_DENIED');
    expect(s.rows()).toEqual([expect.objectContaining({ action: 'auth.staff-profile.read', facilityId: null,
      outcome: 'denied' })]);
  });

  it('records the 401 of an account that is no longer active', async () => {
    const s = served(null);
    await expect(s.run({ actor })).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(s.rows()).toEqual([expect.objectContaining({ facilityId: null, outcome: 'denied' })]);
  });

  it('(why) an interceptor-audited facility-optional staff route answers 503 with nothing recorded when no facility is resolved', async () => {
    const s = served();
    await expect(s.run({ actor }, FacilityOptionalInterceptorAudited.prototype.read, FacilityOptionalInterceptorAudited))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(s.rows()).toEqual([]);
  });
});
