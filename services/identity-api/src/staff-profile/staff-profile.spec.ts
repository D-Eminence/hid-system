jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  ACCOUNT_ONLY_ALLOWED, AUDIT_ACTION, FACILITY_OPTIONAL, PATIENT_ALLOWED, PUBLIC_ROUTE, REQUIRED_PERMISSIONS,
} from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { StaffProfileController } from './staff-profile.controller';
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
    patientAllowed: meta(PATIENT_ALLOWED), accountOnly: meta(ACCOUNT_ONLY_ALLOWED), isPublic: meta(PUBLIC_ROUTE),
    permissions: meta(REQUIRED_PERMISSIONS) };
}

describe('GET identity/me/staff-profile (SX-5)', () => {
  function setup(row: Record<string, unknown> | undefined) {
    const query = jest.fn().mockResolvedValue({ rows: row ? [row] : [] });
    return { query, service: new StaffProfileService({ query } as unknown as DatabaseService) };
  }
  const row = { account_id: ACCOUNT, display_name: 'Ada Fictional', email: 'ada@example.test',
    password_changed_at: new Date('2026-10-01T09:00:00Z'), has_password: true,
    account_created_at: '2026-01-05T08:00:00Z', full_name: 'Ada N. Fictional', licence_number: 'mdcn/12-345 67' };

  it('is a staff-only read of the caller\'s own account: no permission, facility optional, audited', () => {
    expect(route(StaffProfileController, 'read')).toEqual({ base: 'identity', path: 'me/staff-profile',
      method: RequestMethod.GET, audit: 'identity.staff-profile.read', facilityOptional: true, patientAllowed: undefined,
      accountOnly: undefined, isPublic: undefined, permissions: undefined });
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
    const read = jest.fn();
    const controller = new StaffProfileController({ read } as unknown as StaffProfileService);
    expect(() => controller.read({ actor: { ...actor, kind: 'patient' } } as unknown as HidRequest)).toThrow(DomainProblem);
    expect(() => controller.read({} as HidRequest)).toThrow(DomainProblem);
    expect(read).not.toHaveBeenCalled();
    controller.read({ actor, facilityId: SECOND_FACILITY } as unknown as HidRequest);
    expect(read).toHaveBeenCalledWith(actor, SECOND_FACILITY);
  });

  it('keeps the licence hint rule of identity.licence_number_hint', () => {
    expect(licenceNumberHint('MDCN/12345')).toBe('2345');
    expect(licenceNumberHint('ab-1')).toBe('AB1');
    expect(licenceNumberHint('--')).toBeNull();
    expect(licenceNumberHint(null)).toBeNull();
  });
});
